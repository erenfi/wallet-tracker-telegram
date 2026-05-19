# Telegram Wallet Tracker

Telegram wallet tracker that can send alerts to Telegram and/or Discord:

- native transfers involving tracked wallets
- ERC20/ERC721/ERC1155-style `Transfer(address,address,uint256)` logs involving tracked wallets

It uses direct JSON-RPC polling, Telegram Bot API long polling, and optional
Discord webhooks. No npm install is required.

## Setup

1. Create a Telegram bot with `@BotFather`.
2. Copy `.env.example` to `.env`.
3. Set `TELEGRAM_BOT_TOKEN`.
4. Optionally set `DISCORD_WEBHOOK_URL` for Discord alerts.
5. Set RPC URLs for the chains you want.
6. Run:

```bash
npm start
```

The first Telegram chat that sends `/start` becomes authorized if
`AUTHORIZED_CHAT_IDS` is blank. To lock it down upfront, set:

```env
AUTHORIZED_CHAT_IDS=123456789
```

## Commands

```text
/start
/help
/chains
/track <chain> <address> [label]
/untrack <chain> <address>
/list
/status
```

Examples:

```text
/track base 0x0000000000000000000000000000000000000000 burn
/track ethereum vitalik.eth vitalik
```

Use `0x` addresses. ENS resolution is intentionally left out of this
no-dependency build.

## Run In Background

```bash
tmux new-session -d -s wallet-tracker 'cd /home/hafiro/wallet-tracker-telegram && npm start 2>&1 | tee wallet-tracker.log'
tmux capture-pane -pt wallet-tracker -S -120
tmux kill-session -t wallet-tracker
```
