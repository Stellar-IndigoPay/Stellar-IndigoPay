#!/usr/bin/env python3
"""Generate per-scene narration audio for the 3-minute pitch video.

Uses edge-tts (free neural voices) — warm, confident female (en-US-AriaNeural).
Outputs MP3 clips + a JSON manifest of scene durations to .pitch-work/audio/.
"""

import asyncio
import json
import os

import edge_tts

WORK = ".pitch-work"
AUDIO_DIR = os.path.join(WORK, "audio")
VOICE = "en-US-AriaNeural"
RATE = "+8%"  # ~2:55 total incl. scene pauses; tuned for the 3-min target

# Scene number -> narration text (verbatim from scripts/pitch-video-script.md)
SCENES = {
    1: "Every year, billions of dollars are pledged to fight climate change. But ask a donor where their money actually went — and most can't answer. The gap between giving and impact is the one problem our planet can't afford.",
    2: "Donations pass through layers of intermediaries. Fees eat the gift. Trust is assumed, never verified. And for the people doing the real work — the projects on the ground — accountability is a black box. What if giving could be instant, borderless, and transparent by design? What if every single donation could be verified on a public ledger — by anyone, anywhere, forever?",
    3: "Meet Stellar-IndigoPay. An open-source climate donation platform built on Stellar. XLM flows directly from the donor's wallet to the project's wallet. No custodian. No middleman. Every donation is recorded on-chain through a Soroban smart contract — so impact is publicly auditable, not promised. Your Stellar key is your identity. No email. No password. Just you, the project, and a ledger that never lies.",
    4: "Give from anywhere. A web app for the full experience. A mobile app with biometric security and QR-to-give. A browser extension that finds Stellar addresses on any page — and lets you donate in one click. Donate in XLM or USDC, with an on-chain oracle handling conversion. Track your lifetime impact, earn wallet-bound badges — from Seedling to Earth Guardian — and get plain-language AI summaries of exactly where your money goes. Watch donations stream in live, see your name on the leaderboard, and let your reputation travel with you across every dApp.",
    5: "Under the hood, this isn't a demo. It's four production Soroban contracts — a donation ledger, escrow, cross-chain attestation, and an on-chain oracle — with three hundred and eight structured error codes. Milestone-based payouts with multi-sig. Quadratic-voting governance. ZK anonymous giving. Gas-optimized to fit Soroban's limits. Deployed on Stellar Testnet today, and verifiable on Stellar Expert. It's hardened like a real product: two thousand four hundred tests, ninety-nine point five percent coverage enforced in CI, fuzzing, security scanning, and full observability.",
    6: "And it isn't just us building it. Eighty-nine contributors. One hundred and eighty-five merged pull requests. A living pipeline where clear issues become shipped features — wave after wave. This is an open community, funding the planet, one XLM at a time.",
    7: "Stellar-IndigoPay. Fund the planet — one XLM at a time. Open source. Live on Stellar Testnet. Try it today, and watch your donation become verifiable impact.",
}


async def synth(n: int, text: str) -> str:
    out = os.path.join(AUDIO_DIR, f"scene_{n:02d}.mp3")
    await edge_tts.Communicate(text, VOICE, rate=RATE).save(out)
    return out


def main() -> None:
    os.makedirs(AUDIO_DIR, exist_ok=True)
    from mutagen.mp3 import MP3

    manifest = {}
    total = 0.0
    for n, text in SCENES.items():
        path = asyncio.run(synth(n, text))
        dur = MP3(path).info.length
        manifest[n] = {"file": path, "duration": round(dur, 3), "chars": len(text)}
        total += dur
        print(f"  scene {n}: {dur:.2f}s  ({len(text)} chars)")

    manifest_path = os.path.join(AUDIO_DIR, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nTotal narration: {total:.2f}s  ({total/60:.2f} min)")
    print(f"Manifest written to {manifest_path}")


if __name__ == "__main__":
    main()
