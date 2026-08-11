#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
罗德岛棋局 · 音频采样生成器 (gen_audio_samples.py)
------------------------------------------------------------------
纯标准库合成"真实采样"（分层振荡器 + 滤波噪声 + ADSR + 轻混响），
输出两份产物：
  1) audio/<key>_<v>.wav          真实采样素材库（供后续替换/服务器部署）
  2) audio_assets.js              window.AUDIO_ASSETS = { "<key>": ["data:audio/wav;base64,...", ...] }
                                  base64 内嵌，使游戏可离线双击运行（file:// 下 fetch 被拦截，
                                  故用内嵌 data URI + decodeAudioData）。

设计：Game Audio Engineer。约束：无 numpy / 无外部依赖（仅 stdlib）。
用法：python3 tools/gen_audio_samples.py
"""
import os
import math
import struct
import base64
import random

SR = 22050                      # 采样率（短促 SFX，22.05k 足够；引擎会自动重采样到上下文）
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "audio")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

random.seed(12345)              # 可复现：重复运行得到完全一致的文件


# ---------------------------------------------------------------------------
# 合成原语
# ---------------------------------------------------------------------------
def osc(f0, f1, dur, type_="sine", amp=1.0):
    """单个振荡器音，支持起止频率滑音。"""
    n = max(1, int(dur * SR))
    out = [0.0] * n
    for i in range(n):
        t = i / SR
        f = f0 + (f1 - f0) * (i / (n - 1) if n > 1 else 0)
        ph = 2 * math.pi * f * t
        if type_ == "sine":
            v = math.sin(ph)
        elif type_ == "square":
            v = 1.0 if math.sin(ph) >= 0 else -1.0
        elif type_ == "saw":
            v = 2 * (f * t - math.floor(0.5 + f * t))
        elif type_ == "tri":
            v = 2 * abs(2 * (f * t - math.floor(0.5 + f * t))) - 1
        else:
            v = math.sin(ph)
        out[i] = v * amp
    return out


def noise_burst(dur, filt_type="lowpass", freq=1000.0, q=0.7, amp=1.0):
    """滤波白噪声爆发。"""
    n = max(1, int(dur * SR))
    s = [random.uniform(-1, 1) * amp for _ in range(n)]
    return biquad(s, filt_type, freq, q)


def biquad(samples, ftype, freq, q=1.0):
    """RBJ 双二阶：lowpass / highpass / bandpass。"""
    if ftype not in ("lowpass", "highpass", "bandpass"):
        return samples[:]
    w0 = 2 * math.pi * freq / SR
    cosw = math.cos(w0)
    sinw = math.sin(w0)
    alpha = sinw / (2 * q)
    if ftype == "lowpass":
        b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2
    elif ftype == "highpass":
        b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2
    else:  # bandpass
        b0 = alpha; b1 = 0.0; b2 = -alpha
    a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0
    y = [0.0] * len(samples)
    x1 = x2 = y1 = y2 = 0.0
    for i, x0 in enumerate(samples):
        yi = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        y[i] = yi
        x2 = x1; x1 = x0; y2 = y1; y1 = yi
    return y


def delay(s, sec):
    return [0.0] * int(round(sec * SR)) + s


def mix(*arrs):
    if not arrs:
        return []
    m = max(len(a) for a in arrs)
    out = [0.0] * m
    for a in arrs:
        for i in range(len(a)):
            out[i] += a[i]
    return out


def env(samples, a=0.005, d=0.05, s=0.7, r=0.08):
    """ADSR 包络（s 为持续电平比例 0..1）。超短样本时按比例压缩分段避免越界。"""
    n = len(samples)
    out = [0.0] * n
    na = int(a * SR); nd = int(d * SR); nr = int(r * SR)
    total = na + nd + nr
    if total > n and total > 0:
        scale = n / total
        na = int(na * scale); nd = int(nd * scale); nr = int(nr * scale)
    ns = max(0, n - na - nd - nr)
    i = 0
    for k in range(na):
        out[i] = samples[i] * (k / na if na else 1); i += 1
    for k in range(nd):
        out[i] = samples[i] * (1 - (1 - s) * (k / nd if nd else 1)); i += 1
    for k in range(ns):
        out[i] = samples[i] * s; i += 1
    for k in range(nr):
        out[i] = samples[i] * s * (1 - (k / nr if nr else 1)); i += 1
    return out


def rev(samples, wet=0.2):
    """极简反馈延迟混响（几条短延迟线 + 反馈），给短促 SFX 一点空间感。"""
    if wet <= 0 or not samples:
        return samples
    delays = [int(d * SR) for d in (0.021, 0.029, 0.037, 0.043)]
    fb = 0.30
    out = list(samples)
    for dl in delays:
        if dl <= 1:
            continue
        buf = [0.0] * dl
        for i in range(len(samples)):
            delayed = buf[i % dl]
            y = samples[i] + fb * delayed
            out[i] += wet * y * 0.5
            buf[i % dl] = y
    return out


def norm(samples, peak=0.92):
    if not samples:
        return samples
    mx = max(abs(v) for v in samples)
    if mx < 1e-6:
        return samples
    g = peak / mx
    return [v * g for v in samples]


def to_wav_bytes(samples):
    data = bytearray()
    for v in samples:
        iv = int(round(v * 32767))
        iv = max(-32768, min(32767, iv))
        data += struct.pack("<h", iv)
    nbytes = len(data)
    header = (b"RIFF" + struct.pack("<I", 36 + nbytes) + b"WAVE"
              + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, SR, SR * 2, 2, 16)
              + b"data" + struct.pack("<I", nbytes))
    return header + data


# ---------------------------------------------------------------------------
# 事件合成（key -> (变体数, 生成函数)）。v=变体序号，用于确定性微扰。
# ---------------------------------------------------------------------------
def DET(v, amount=0.03):
    """变体确定性失谐系数。"""
    return 1.0 + amount * (v - 1)


def chord_arpeggio(notes, step, type_, amp, tail):
    out = []
    for i, f in enumerate(notes):
        out = mix(out, delay(osc(f, f, step * 1.3, type_, amp), i * step))
    out = env(out, 0.005, 0.10, 0.0, tail)
    return out


EVENTS = {}


def reg(key, count, fn):
    EVENTS[key] = (count, fn)


# —— UI ——
reg("ui/click", 3, lambda v: env(osc(430 * DET(v), 470 * DET(v), 0.05, "tri", 0.9), 0.002, 0.03, 0.0, 0.02))
reg("ui/select", 3, lambda v: env(osc(620 * DET(v, 0.05), 680 * DET(v, 0.05), 0.045, "sine", 0.8), 0.002, 0.02, 0.0, 0.02))
reg("ui/open", 2, lambda v: rev(env(osc(300, 540, 0.12, "sine", 0.8), 0.01, 0.06, 0.0, 0.05), 0.15))
reg("ui/close", 2, lambda v: env(osc(540, 300, 0.10, "sine", 0.7), 0.01, 0.05, 0.0, 0.04))
reg("ui/error", 2, lambda v: env(mix(osc(200, 120, 0.18, "saw", 0.8),
                                      osc(400, 240, 0.18, "saw", 0.25)), 0.002, 0.10, 0.0, 0.05))


# —— 商店 / 经济 ——
reg("shop/buy", 3, lambda v: env(mix(
    osc(690 * DET(v), 720 * DET(v), 0.07, "square", 0.5),
    delay(osc(980, 1040, 0.09, "square", 0.35), 0.05),
    delay(noise_burst(0.02, "highpass", 2000, 0.7, 0.4), 0.0)), 0.002, 0.08, 0.0, 0.04))
reg("shop/reroll", 3, lambda v: env(osc(500 * DET(v), 540 * DET(v), 0.05, "tri", 0.7), 0.002, 0.025, 0.0, 0.02))
reg("shop/levelup", 2, lambda v: rev(chord_arpeggio([523, 659, 784, 1046], 0.06, "tri", 0.5, 0.10), 0.18))
reg("shop/sell", 3, lambda v: env(osc(320 * DET(v), 200 * DET(v), 0.10, "sine", 0.7), 0.005, 0.05, 0.0, 0.04))
reg("shop/insufficient", 2, lambda v: env(osc(180, 120, 0.18, "saw", 0.7), 0.002, 0.10, 0.0, 0.05))


# —— 部署 ——
reg("deploy/place", 3, lambda v: env(mix(
    osc(260 * DET(v), 340 * DET(v), 0.10, "sine", 0.6),
    noise_burst(0.12, "lowpass", 900, 0.7, 0.5)), 0.001, 0.06, 0.0, 0.03))
reg("deploy/pickup", 3, lambda v: env(osc(380 * DET(v), 420 * DET(v), 0.06, "sine", 0.7), 0.002, 0.03, 0.0, 0.02))
reg("deploy/invalid", 2, lambda v: env(osc(160, 110, 0.12, "square", 0.6), 0.002, 0.06, 0.0, 0.04))


# —— 战斗 ——
reg("combat/hit", 4, lambda v: env(mix(
    osc(150 * DET(v), 55 * DET(v), 0.10, "sine", 0.9),
    noise_burst(0.08, "lowpass", 700, 0.7, 0.5),
    delay(noise_burst(0.02, "highpass", 2500, 0.7, 0.4), 0.0)), 0.001, 0.06, 0.0, 0.03))
reg("combat/hit_arts", 4, lambda v: rev(
    biquad(env(mix(
        osc(1000 * DET(v), 520 * DET(v), 0.14, "sine", 0.7),
        osc(1500, 800, 0.12, "sine", 0.3),
        noise_burst(0.05, "bandpass", 1800, 2.0, 0.3)), 0.002, 0.08, 0.0, 0.05), "bandpass", 1200, 1.2), 0.10))
reg("combat/skill_default", 3, lambda v: env(biquad(
    osc(540 * DET(v), 860 * DET(v), 0.16, "tri", 0.6), "lowpass", 3000, 0.7), 0.003, 0.09, 0.0, 0.05))
reg("combat/skill_heal", 3, lambda v: rev(env(biquad(mix(
    osc(720 * DET(v), 1120 * DET(v), 0.20, "sine", 0.6),
    osc(1080, 1680, 0.18, "sine", 0.25)), "lowpass", 2400, 0.7), 0.01, 0.10, 0.0, 0.08), 0.20))
reg("combat/skill_shield", 3, lambda v: env(mix(
    osc(420 * DET(v), 640 * DET(v), 0.22, "tri", 0.6),
    noise_burst(0.08, "highpass", 3000, 0.7, 0.3)), 0.005, 0.12, 0.0, 0.06))
reg("combat/skill_buff", 3, lambda v: env(biquad(mix(
    osc(460 * DET(v), 920 * DET(v), 0.18, "square", 0.5),
    osc(690, 1380, 0.16, "square", 0.2)), "lowpass", 3000, 0.7), 0.003, 0.10, 0.0, 0.05))
reg("combat/skill_def", 3, lambda v: env(mix(
    osc(560 * DET(v), 220 * DET(v), 0.18, "saw", 0.6),
    noise_burst(0.08, "lowpass", 1400, 0.8, 0.4)), 0.002, 0.10, 0.0, 0.05))
reg("combat/skill_summon", 3, lambda v: rev(env(biquad(mix(
    osc(150 * DET(v), 250 * DET(v), 0.30, "saw", 0.6),
    noise_burst(0.25, "lowpass", 500, 0.7, 0.4)), "lowpass", 900, 0.7), 0.02, 0.15, 0.0, 0.10), 0.15))
reg("combat/skill_burn", 3, lambda v: env(biquad(mix(
    osc(560 * DET(v), 360 * DET(v), 0.10, "saw", 0.4),
    noise_burst(0.10, "bandpass", 600, 3.0, 0.5)), "bandpass", 700, 2.0), 0.001, 0.05, 0.0, 0.04))
reg("combat/skill_cast", 2, lambda v: rev(env(biquad(mix(
    osc(680 * DET(v), 1040 * DET(v), 0.5, "sine", 0.5),
    osc(1020, 1560, 0.45, "sine", 0.2)), "lowpass", 3000, 0.7), 0.05, 0.20, 0.0, 0.20), 0.35))
reg("combat/heal", 3, lambda v: rev(env(biquad(mix(
    osc(720 * DET(v), 1120 * DET(v), 0.18, "sine", 0.6),
    osc(1080, 1680, 0.16, "sine", 0.25)), "lowpass", 2400, 0.7), 0.01, 0.09, 0.0, 0.07), 0.18))
reg("combat/shield", 3, lambda v: env(mix(
    osc(420 * DET(v), 640 * DET(v), 0.20, "tri", 0.6),
    noise_burst(0.08, "highpass", 3000, 0.7, 0.3)), 0.005, 0.11, 0.0, 0.06))
reg("combat/summon", 3, lambda v: rev(env(biquad(mix(
    osc(150 * DET(v), 250 * DET(v), 0.30, "saw", 0.6),
    noise_burst(0.25, "lowpass", 500, 0.7, 0.4)), "lowpass", 900, 0.7), 0.02, 0.15, 0.0, 0.10), 0.15))
reg("combat/burn", 3, lambda v: env(biquad(mix(
    osc(560 * DET(v), 360 * DET(v), 0.10, "saw", 0.4),
    noise_burst(0.10, "bandpass", 600, 3.0, 0.5)), "bandpass", 700, 2.0), 0.001, 0.05, 0.0, 0.04))
reg("combat/death_ally", 3, lambda v: rev(env(biquad(mix(
    osc(260 * DET(v), 90 * DET(v), 0.30, "saw", 0.7),
    noise_burst(0.18, "lowpass", 400, 0.7, 0.4)), "lowpass", 800, 0.7), 0.005, 0.15, 0.0, 0.12), 0.20))
reg("combat/death_enemy", 3, lambda v: rev(env(biquad(mix(
    osc(200 * DET(v), 70 * DET(v), 0.30, "saw", 0.6),
    noise_burst(0.18, "lowpass", 400, 0.7, 0.4)), "lowpass", 800, 0.7), 0.005, 0.15, 0.0, 0.12), 0.20))


# —— 战略 / 节点 ——
reg("strategic/node_enter", 2, lambda v: rev(env(osc(330 * DET(v), 500 * DET(v), 0.14, "sine", 0.7), 0.01, 0.06, 0.0, 0.05), 0.12))
reg("strategic/bond_unlock", 2, lambda v: rev(env(mix(
    osc(523 * DET(v), 523 * DET(v), 0.22, "tri", 0.4),
    osc(659, 659, 0.22, "tri", 0.4),
    osc(784, 784, 0.22, "tri", 0.4)), 0.005, 0.10, 0.0, 0.10), 0.25))
reg("strategic/strategy_pick", 2, lambda v: chord_arpeggio([440, 554, 659, 880], 0.06, "square", 0.4, 0.08))
reg("strategic/encounter_pick", 2, lambda v: chord_arpeggio([392, 494, 587], 0.07, "tri", 0.4, 0.08))
reg("strategic/promote", 2, lambda v: rev(chord_arpeggio([523, 659, 784, 1046, 1318], 0.09, "tri", 0.5, 0.10), 0.20))


# —— 结算 stinger（走音乐总线）——
reg("result/win", 1, lambda v: rev(chord_arpeggio([440, 554, 659, 880], 0.10, "tri", 0.6, 0.20), 0.30))
reg("result/lose", 1, lambda v: rev(env(mix(
    chord_arpeggio([440, 349, 294, 220], 0.13, "saw", 0.5, 0.05),
    noise_burst(0.4, "lowpass", 400, 0.7, 0.25)), 0.005, 0.10, 0.0, 0.10), 0.20))
reg("result/boss", 1, lambda v: rev(env(biquad(mix(
    osc(110, 110, 0.8, "saw", 0.5),
    osc(138.6, 138.6, 0.8, "saw", 0.4),
    osc(164.8, 164.8, 0.8, "saw", 0.4)), "lowpass", 600, 0.7), 0.02, 0.3, 0.0, 0.2), 0.30))


# ---------------------------------------------------------------------------
# 主流程：合成 -> WAV 文件 + base64
# ---------------------------------------------------------------------------
def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    assets = {}
    total = 0
    raw_bytes = 0
    for key, (count, fn) in EVENTS.items():
        uris = []
        for v in range(count):
            samples = norm(fn(v), peak=0.92)
            wav = to_wav_bytes(samples)
            raw_bytes += len(wav)
            # 真实 WAV 素材
            wav_path = os.path.join(OUT_DIR, "%s_%d.wav" % (key.replace("/", "_"), v))
            with open(wav_path, "wb") as f:
                f.write(wav)
            # base64 内嵌
            b64 = base64.b64encode(wav).decode("ascii")
            uris.append("data:audio/wav;base64," + b64)
            total += 1
        assets[key] = uris

    # 写出 audio_assets.js
    lines = []
    lines.append("/* =============================================================================")
    lines.append(" * 罗德岛棋局 · 音频采样资源 (audio_assets.js)  —— 自动生成，请勿手改")
    lines.append(" * 由 tools/gen_audio_samples.py 生成。window.AUDIO_ASSETS[key] = [dataURI, ...]")
    lines.append(" * 离线双击运行（file://）下浏览器拦截 fetch 本地文件，故采样以 base64 内嵌。")
    lines.append(" * 如需替换为真实录音：把 .wav 放到 audio/，重跑生成器，或直接编辑本文件。")
    lines.append(" * ========================================================================== */")
    lines.append("window.AUDIO_ASSETS = {")
    for i, (key, uris) in enumerate(assets.items()):
        comma = "," if i < len(assets) - 1 else ""
        lines.append('  "%s": [' % key)
        for j, u in enumerate(uris):
            inner = "," if j < len(uris) - 1 else ""
            lines.append('    "%s"%s' % (u, inner))
        lines.append("  ]" + comma)
    lines.append("};")
    out_path = os.path.join(ROOT, "audio_assets.js")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print("OK  采样数=%d  真实WAV目录=%s  audio_assets.js=%s  原始音频≈%.2f MB  base64≈%.2f MB"
          % (total, OUT_DIR, out_path, raw_bytes / 1048576.0, (raw_bytes * 4 / 3) / 1048576.0))


if __name__ == "__main__":
    main()
