import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(here, "data.json");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC721_INTERFACE_ID = "0x80ac58cd";
const ERC1155_TRANSFER_SINGLE_TOPIC = "0xc3d58168c5ae7391d245d631d685e96f63564d0f17dbf7ef9d2a0bc415e3e";
const ERC1155_TRANSFER_BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70f89f5e6416f0fd9d98d0c88be3f2f22a7f6fcd5fdda";
const MARKETPLACES = {
  ethereum: {
    "0x0000000000000068f116a894984e2db1123eb395": "OpenSea Seaport",
    "0x00000000000000adc04c56bf30ac9d3c0aaf14dc": "OpenSea Seaport",
    "0x00000000000001ad428e4906ae43d8f9852d0dd6": "OpenSea Seaport",
    "0x00000000006c3852cbef3e08e8df289169ede581": "OpenSea Seaport",
    "0x7be8076f4ea4a4ad08075c2508e481d6c946d12b": "OpenSea Wyvern",
  },
  base: {
    "0x0000000000000068f116a894984e2db1123eb395": "OpenSea Seaport",
    "0x00000000000000adc04c56bf30ac9d3c0aaf14dc": "OpenSea Seaport",
  },
};
const KNOWN_TOKENS = {
  ethereum: {
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", name: "USD Coin", decimals: 6 },
  },
  base: {
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", name: "USD Coin", decimals: 6 },
  },
};

loadEnv();

const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  telegramPollTimeout: Number.parseInt(process.env.TELEGRAM_POLL_TIMEOUT || "50", 10),
  chainPollMs: Number.parseInt(process.env.CHAIN_POLL_MS || "12000", 10),
  maxBlocksPerPoll: Number.parseInt(process.env.MAX_BLOCKS_PER_POLL || "25", 10),
  confirmations: Number.parseInt(process.env.CONFIRMATIONS || "1", 10),
  minNativeIncomingWei: parseDecimalUnits(process.env.MIN_NATIVE_INCOMING_ALERT || "0", 18),
  minNativeOutgoingWei: parseDecimalUnits(process.env.MIN_NATIVE_OUTGOING_ALERT || "0", 18),
  discordMinSendIntervalMs: Number.parseInt(process.env.DISCORD_MIN_SEND_INTERVAL_MS || "1200", 10),
  discordMaxQueueSize: Number.parseInt(process.env.DISCORD_MAX_QUEUE_SIZE || "250", 10),
  authorizedChatIds: splitCsv(process.env.AUTHORIZED_CHAT_IDS || ""),
};

const discordQueue = [];
let discordQueueRunning = false;
let discordNextSendAt = 0;

const chains = JSON.parse(readFileSync(join(here, "chains.json"), "utf8"))
  .map((chain) => ({ ...chain, rpcUrl: process.env[chain.rpcEnv] || "" }))
  .filter((chain) => chain.rpcUrl);

const state = loadState();

function loadEnv() {
  const path = join(here, ".env");
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function splitCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function loadState() {
  if (!existsSync(DATA_PATH)) {
    return { authorizedChatIds: [], offset: 0, wallets: [], lastBlocks: {}, seen: [], tokenMeta: {} };
  }
  const loaded = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  return { tokenMeta: {}, ...loaded };
}

function saveState() {
  const compact = {
    ...state,
    seen: [...new Set(state.seen)].slice(-5000),
  };
  Object.assign(state, compact);
  writeFileSync(DATA_PATH, `${JSON.stringify(compact, null, 2)}\n`);
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function normalizeAddress(value) {
  if (!isAddress(value)) throw new Error(`Invalid address: ${value}`);
  return value.toLowerCase();
}

function short(value, left = 6, right = 4) {
  if (!value) return "";
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}

function html(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function unhtml(value) {
  return String(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function telegramHtmlToDiscord(text, chain = null) {
  return unhtml(text)
    .replace(/<b>(.*?)<\/b>/gs, "**$1**")
    .replace(/<code>(.*?)<\/code>/gs, (_match, value) => {
      const clean = value.trim();
      if (chain && isAddress(clean)) return `[${short(clean)}](${chain.explorerAddress}${clean})`;
      return `\`${clean}\``;
    })
    .replace(/<a href="([^"]+)">(.*?)<\/a>/gs, "$2 <$1>")
    .replace(/<[^>]+>/g, "");
}

function formatWei(hexValue) {
  return formatUnits(BigInt(hexValue || "0x0"), 18);
}

function parseDecimalUnits(value, decimals) {
  const clean = String(value || "0").trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) return 0n;
  const [whole, frac = ""] = clean.split(".");
  const paddedFrac = frac.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFrac || "0");
}

function formatUnits(value, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  const fracText = frac === 0n ? "" : `.${frac.toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "")}`;
  return `${whole}${fracText}`;
}

function formatTokenAmount(raw, meta) {
  const value = typeof raw === "bigint" ? raw : BigInt(raw || "0x0");
  const decimals = Number.isFinite(meta?.decimals) ? meta.decimals : 18;
  return `${formatUnits(value, decimals)} ${meta?.symbol || "tokens"}`;
}

function formatNetAmount(value, meta) {
  if (value === 0n) return "";
  return `${value > 0n ? "+" : "-"}${formatTokenAmount(value > 0n ? value : -value, meta)}`;
}

function decodeAbiString(result) {
  if (!result || result === "0x") return "";
  const clean = result.replace(/^0x/, "");
  try {
    if (clean.length === 64) {
      return Buffer.from(clean, "hex").toString("utf8").replace(/\0+$/g, "").trim();
    }
    const offset = Number.parseInt(clean.slice(0, 64), 16);
    const len = Number.parseInt(clean.slice(offset * 2, offset * 2 + 64), 16);
    return Buffer.from(clean.slice(offset * 2 + 64, offset * 2 + 64 + len * 2), "hex").toString("utf8").trim();
  } catch {
    return "";
  }
}

function decodeAbiUint(result) {
  if (!result || result === "0x") return null;
  try {
    return Number(BigInt(result));
  } catch {
    return null;
  }
}

function bigintToHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function topicAddress(address) {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function addressFromTopic(topic) {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function marketplaceName(chain, txTo) {
  if (!txTo) return "";
  return MARKETPLACES[chain.key]?.[txTo.toLowerCase()] || "";
}

function knownPaymentToken(chain, token) {
  return KNOWN_TOKENS[chain.key]?.[token.toLowerCase()];
}

function tokenCacheKey(chain, address) {
  return `${chain.key}:${address.toLowerCase()}`;
}

function trackedWalletMap(wallets) {
  return new Map(wallets.map((wallet) => [wallet.address, wallet]));
}

function isTracked(address, tracked) {
  return tracked.has(address?.toLowerCase());
}

function trackedLabel(address, tracked) {
  return tracked.get(address?.toLowerCase())?.label || short(address);
}

async function rpc(chain, method, params) {
  const res = await fetch(chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${chain.key} ${method}: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

async function safeCallString(chain, to, data) {
  try {
    return decodeAbiString(await rpc(chain, "eth_call", [{ to, data }, "latest"]));
  } catch {
    return "";
  }
}

async function safeCallUint(chain, to, data) {
  try {
    return decodeAbiUint(await rpc(chain, "eth_call", [{ to, data }, "latest"]));
  } catch {
    return null;
  }
}

async function supportsInterface(chain, to, interfaceId) {
  const padded = interfaceId.replace(/^0x/, "").padEnd(64, "0");
  try {
    const result = await rpc(chain, "eth_call", [{ to, data: `0x01ffc9a7${padded}` }, "latest"]);
    return BigInt(result) === 1n;
  } catch {
    return false;
  }
}

async function tokenMeta(chain, address, kind = "erc20") {
  const normalized = address.toLowerCase();
  const known = knownPaymentToken(chain, normalized);
  if (known) return { ...known, kind: "erc20" };

  const key = tokenCacheKey(chain, normalized);
  if (state.tokenMeta[key]) return state.tokenMeta[key];

  const [symbol, name, decimals, is721] = await Promise.all([
    safeCallString(chain, normalized, "0x95d89b41"),
    safeCallString(chain, normalized, "0x06fdde03"),
    safeCallUint(chain, normalized, "0x313ce567"),
    supportsInterface(chain, normalized, ERC721_INTERFACE_ID),
  ]);
  const meta = {
    symbol: symbol || short(normalized),
    name: name || "",
    decimals: kind === "erc20" ? (decimals ?? 18) : 0,
    kind: is721 || kind === "erc721" ? "erc721" : kind,
  };
  state.tokenMeta[key] = meta;
  saveState();
  return meta;
}

async function telegram(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description || JSON.stringify(json)}`);
  return json.result;
}

async function sendMessage(chatId, text, options = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options,
  });
}

async function sendDiscordMessage(text) {
  if (!config.discordWebhookUrl) return;
  const chain = chainFromAlertText(text);
  const discordText = telegramHtmlToDiscord(text, chain);
  const chunks = chunkText(discordText, 1900);
  for (const chunk of chunks) {
    enqueueDiscordMessage(chunk);
  }
}

function enqueueDiscordMessage(content) {
  if (discordQueue.length >= config.discordMaxQueueSize) {
    discordQueue.shift();
    console.error("[discord] queue full; dropped oldest message");
  }
  discordQueue.push(content);
  void drainDiscordQueue();
}

async function drainDiscordQueue() {
  if (discordQueueRunning) return;
  discordQueueRunning = true;

  while (discordQueue.length > 0) {
    const waitMs = Math.max(0, discordNextSendAt - Date.now());
    if (waitMs > 0) await delay(waitMs);

    const content = discordQueue[0];
    const result = await postDiscordChunk(content);

    if (result.ok) {
      discordQueue.shift();
      discordNextSendAt = Date.now() + config.discordMinSendIntervalMs;
      continue;
    }

    if (result.retryAfterMs > 0) {
      discordNextSendAt = Date.now() + result.retryAfterMs;
      console.error(`[discord] rate limited; retrying in ${Math.ceil(result.retryAfterMs)}ms`);
      continue;
    }

    discordQueue.shift();
    console.error(`[discord] dropped message: ${result.error}`);
  }

  discordQueueRunning = false;
}

async function postDiscordChunk(content) {
  try {
    const res = await fetch(config.discordWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Wallet Tracker",
        content,
        allowed_mentions: { parse: [] },
      }),
    });

    if (res.ok) return { ok: true, retryAfterMs: 0, error: "" };

    const body = await res.text().catch(() => "");
    let retryAfterMs = 0;
    if (res.status === 429) {
      try {
        const parsed = JSON.parse(body);
        retryAfterMs = Math.ceil(Number(parsed.retry_after || 1) * 1000) + 250;
      } catch {
        retryAfterMs = Number.parseFloat(res.headers.get("retry-after") || "1") * 1000 + 250;
      }
    }
    return { ok: false, retryAfterMs, error: `webhook ${res.status}: ${body || res.statusText}` };
  } catch (err) {
    return { ok: false, retryAfterMs: 1000, error: err.message };
  }
}

function chainFromAlertText(text) {
  const firstLine = unhtml(text.split("\n")[0] || "").replace(/<[^>]+>/g, "");
  return chains.find((chain) => firstLine.includes(chain.name)) || null;
}

function chunkText(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    const cut = remaining.lastIndexOf("\n", limit);
    const idx = cut > 0 ? cut : limit;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function isAuthorized(chatId) {
  const id = String(chatId);
  return config.authorizedChatIds.includes(id) || state.authorizedChatIds.includes(id);
}

function authorizeFirstChat(chatId) {
  const id = String(chatId);
  if (config.authorizedChatIds.length > 0 || state.authorizedChatIds.length > 0) return false;
  state.authorizedChatIds.push(id);
  saveState();
  return true;
}

function chainByKey(key) {
  return chains.find((chain) => chain.key === key.toLowerCase());
}

function trackedForChain(chainKey) {
  return state.wallets.filter((wallet) => wallet.chain === chainKey);
}

function labelsFor(chainKey, address) {
  return state.wallets
    .filter((wallet) => wallet.chain === chainKey && wallet.address === address.toLowerCase())
    .map((wallet) => wallet.label || short(wallet.address));
}

async function resolveAddress(input) {
  if (isAddress(input)) return input;
  throw new Error(`Not a 0x address: ${input}`);
}

async function handleCommand(message) {
  const chatId = message.chat.id;
  const text = message.text || "";
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw.split("@")[0].toLowerCase();

  if (cmd === "/start") {
    const claimed = authorizeFirstChat(chatId);
    if (!isAuthorized(chatId)) {
      await sendMessage(chatId, "Not authorized.");
      return;
    }
    await sendMessage(
      chatId,
      `${claimed ? "This chat is now authorized.\n\n" : ""}${helpText()}`,
    );
    return;
  }

  if (!isAuthorized(chatId)) {
    await sendMessage(chatId, "Not authorized. Set AUTHORIZED_CHAT_IDS or send /start from the first allowed chat.");
    return;
  }

  if (cmd === "/help") {
    await sendMessage(chatId, helpText());
    return;
  }

  if (cmd === "/chains") {
    await sendMessage(chatId, chains.map((chain) => `${chain.key} - ${chain.name}`).join("\n") || "No chains configured.");
    return;
  }

  if (cmd === "/status") {
    const lines = chains.map((chain) => {
      const count = trackedForChain(chain.key).length;
      const last = state.lastBlocks[chain.key] || "not started";
      return `${chain.name}: ${count} wallets, last block ${last}`;
    });
    await sendMessage(chatId, lines.join("\n") || "No chains configured.");
    return;
  }

  if (cmd === "/list") {
    if (state.wallets.length === 0) {
      await sendMessage(chatId, "No wallets tracked yet.");
      return;
    }
    const lines = state.wallets.map((wallet) => {
      const chain = chainByKey(wallet.chain);
      return `${chain?.name || wallet.chain}: ${html(wallet.label || short(wallet.address))} <code>${wallet.address}</code>`;
    });
    await sendMessage(chatId, lines.join("\n"));
    return;
  }

  if (cmd === "/track") {
    const [chainKey, addressInput, ...labelParts] = args;
    if (!chainKey || !addressInput) {
      await sendMessage(chatId, "Usage: /track <chain> <address> [label]");
      return;
    }
    const chain = chainByKey(chainKey);
    if (!chain) {
      await sendMessage(chatId, `Unknown or unconfigured chain: ${html(chainKey)}`);
      return;
    }
    const address = normalizeAddress(await resolveAddress(addressInput));
    const label = labelParts.join(" ").trim() || short(address);
    const exists = state.wallets.some((wallet) => wallet.chain === chain.key && wallet.address === address);
    if (!exists) state.wallets.push({ chain: chain.key, address, label, createdAt: new Date().toISOString() });
    saveState();
    await sendMessage(chatId, `${exists ? "Already tracking" : "Tracking"} ${chain.name}: ${html(label)} <code>${address}</code>`);
    return;
  }

  if (cmd === "/untrack") {
    const [chainKey, addressInput] = args;
    if (!chainKey || !addressInput) {
      await sendMessage(chatId, "Usage: /untrack <chain> <address>");
      return;
    }
    const address = normalizeAddress(addressInput);
    const before = state.wallets.length;
    state.wallets = state.wallets.filter((wallet) => !(wallet.chain === chainKey.toLowerCase() && wallet.address === address));
    saveState();
    await sendMessage(chatId, before === state.wallets.length ? "Wallet was not tracked." : "Wallet removed.");
    return;
  }

  await sendMessage(chatId, "Unknown command. Use /help.");
}

function helpText() {
  return [
    "<b>Wallet Tracker</b>",
    "/track &lt;chain&gt; &lt;address&gt; [label]",
    "/untrack &lt;chain&gt; &lt;address&gt;",
    "/list",
    "/chains",
    "/status",
  ].join("\n");
}

async function telegramLoop() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset: state.offset || 0,
        timeout: config.telegramPollTimeout,
        allowed_updates: ["message"],
      });
      for (const update of updates) {
        state.offset = update.update_id + 1;
        saveState();
        if (update.message?.text?.startsWith("/")) await handleCommand(update.message);
      }
    } catch (err) {
      console.error(`[telegram] ${err.message}`);
      await delay(3000);
    }
  }
}

async function scanLoop() {
  while (true) {
    for (const chain of chains) {
      try {
        await scanChain(chain);
      } catch (err) {
        console.error(`[scan] ${err.message}`);
      }
    }
    await delay(config.chainPollMs);
  }
}

async function scanChain(chain) {
  const wallets = trackedForChain(chain.key);
  if (wallets.length === 0) return;

  const latestRaw = await rpc(chain, "eth_blockNumber", []);
  const latest = BigInt(latestRaw) - BigInt(config.confirmations);
  if (latest < 0n) return;

  if (!state.lastBlocks[chain.key]) {
    state.lastBlocks[chain.key] = latest.toString();
    saveState();
    return;
  }

  const from = BigInt(state.lastBlocks[chain.key]) + 1n;
  if (from > latest) return;
  const to = from + BigInt(config.maxBlocksPerPoll - 1) > latest ? latest : from + BigInt(config.maxBlocksPerPoll - 1);

  for (let blockNum = from; blockNum <= to; blockNum += 1n) {
    await scanNativeTransfers(chain, blockNum, wallets);
  }
  await scanTransferLogs(chain, from, to, wallets);

  state.lastBlocks[chain.key] = to.toString();
  saveState();
}

async function scanNativeTransfers(chain, blockNum, wallets) {
  const block = await rpc(chain, "eth_getBlockByNumber", [bigintToHex(blockNum), true]);
  if (!block?.transactions) return;
  const tracked = new Map(wallets.map((wallet) => [wallet.address, wallet]));

  for (const tx of block.transactions) {
    const from = tx.from?.toLowerCase();
    const to = tx.to?.toLowerCase();
    if (!tracked.has(from) && !tracked.has(to)) continue;
    const value = BigInt(tx.value || "0x0");
    if (value === 0n) continue;

    const key = `${chain.key}:native:${tx.hash}`;
    if (state.seen.includes(key)) continue;

    const direction = tracked.has(from) ? "Sent" : "Received";
    if (direction === "Received" && value < config.minNativeIncomingWei) continue;
    if (direction === "Sent" && value < config.minNativeOutgoingWei) continue;

    state.seen.push(key);
    saveState();

    const trackedAddress = tracked.has(from) ? from : to;
    await broadcast(
      `<b>${html(chain.name)} ${direction} ${html(chain.nativeSymbol)}</b>\n` +
        `${html(labelsFor(chain.key, trackedAddress).join(", "))} <code>${trackedAddress}</code>\n` +
        `Amount: <b>${formatWei(tx.value)} ${html(chain.nativeSymbol)}</b>\n` +
        `From: <a href="${chain.explorerAddress}${from}">${short(from)}</a>\n` +
        `To: <a href="${chain.explorerAddress}${to}">${short(to)}</a>\n` +
        `Tx: <a href="${chain.explorerTx}${tx.hash}">${short(tx.hash, 10, 8)}</a>`,
    );
  }
}

async function scanTransferLogs(chain, fromBlock, toBlock, wallets) {
  const txHashes = new Set();

  for (const wallet of wallets) {
    const topic = topicAddress(wallet.address);
    const sent = await rpc(chain, "eth_getLogs", [{
      fromBlock: bigintToHex(fromBlock),
      toBlock: bigintToHex(toBlock),
      topics: [TRANSFER_TOPIC, topic],
    }]);
    const received = await rpc(chain, "eth_getLogs", [{
      fromBlock: bigintToHex(fromBlock),
      toBlock: bigintToHex(toBlock),
      topics: [TRANSFER_TOPIC, null, topic],
    }]);

    for (const log of [...sent, ...received]) {
      txHashes.add(log.transactionHash);
    }
  }

  for (const txHash of txHashes) {
    const key = `${chain.key}:tx:${txHash}`;
    if (state.seen.includes(key)) continue;
    const [tx, receipt] = await Promise.all([
      rpc(chain, "eth_getTransactionByHash", [txHash]),
      rpc(chain, "eth_getTransactionReceipt", [txHash]),
    ]);
    const message = await formatTransactionAlert(chain, tx, receipt, wallets);
    if (!message) continue;
    state.seen.push(key);
    saveState();
    await broadcast(message);
  }
}

function parseTransferLog(log) {
  if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) return null;
  const from = addressFromTopic(log.topics[1]);
  const to = addressFromTopic(log.topics[2]);
  const isNft = log.topics.length >= 4;
  return {
    kind: isNft ? "erc721" : "erc20",
    token: log.address.toLowerCase(),
    from,
    to,
    value: isNft ? BigInt(log.topics[3]) : BigInt(log.data || "0x0"),
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}

function isErc1155Transfer(log) {
  const topic = log.topics?.[0]?.toLowerCase();
  return topic === ERC1155_TRANSFER_SINGLE_TOPIC || topic === ERC1155_TRANSFER_BATCH_TOPIC;
}

async function formatTransactionAlert(chain, tx, receipt, wallets) {
  const tracked = trackedWalletMap(wallets);
  const transfers = receipt.logs
    .map(parseTransferLog)
    .filter(Boolean)
    .filter((transfer) => isTracked(transfer.from, tracked) || isTracked(transfer.to, tracked));
  const erc1155Logs = receipt.logs.filter(isErc1155Transfer);

  if (transfers.length === 0 && erc1155Logs.length === 0) return "";

  const allReceiptTransfers = receipt.logs.map(parseTransferLog).filter(Boolean);
  const market = marketplaceName(chain, tx?.to) || inferMarketplace(chain, tx, allReceiptTransfers);
  const nftTransfers = transfers.filter((transfer) => transfer.kind === "erc721");
  const tokenTransfers = transfers.filter((transfer) => transfer.kind === "erc20");
  const trackedWalletLines = trackedWalletSummary(transfers, tracked);
  const paymentLines = await paymentSummary(chain, tokenTransfers, tracked);
  const nftLines = await nftSummary(chain, nftTransfers, tracked);
  const erc1155Line = erc1155Logs.length > 0 ? `NFT batch transfers: ${erc1155Logs.length}` : "";

  const title = titleForTransaction(chain, market, nftTransfers, tokenTransfers, tracked);
  const lines = [
    `<b>${html(title)}</b>`,
    trackedWalletLines,
    market ? `Venue: <b>${html(market)}</b>` : "",
    nftLines,
    erc1155Line,
    paymentLines,
    tx?.to ? `Contract: <a href="${chain.explorerAddress}${tx.to}">${short(tx.to)}</a>` : "",
    `Tx: <a href="${chain.explorerTx}${receipt.transactionHash}">${short(receipt.transactionHash, 10, 8)}</a>`,
  ].filter(Boolean);

  return lines.join("\n");
}

function inferMarketplace(chain, tx, transfers) {
  const hasNft = transfers.some((transfer) => transfer.kind === "erc721");
  const hasPayment = transfers.some((transfer) => transfer.kind === "erc20" && knownPaymentToken(chain, transfer.token));
  if (hasNft && hasPayment) return "NFT marketplace";
  return marketplaceName(chain, tx?.to);
}

function titleForTransaction(chain, market, nftTransfers, tokenTransfers, tracked) {
  const sentNfts = nftTransfers.filter((transfer) => isTracked(transfer.from, tracked));
  const receivedNfts = nftTransfers.filter((transfer) => isTracked(transfer.to, tracked));
  const sentPayments = tokenTransfers.filter((transfer) => isTracked(transfer.from, tracked) && knownPaymentToken(chain, transfer.token));
  const receivedPayments = tokenTransfers.filter((transfer) => isTracked(transfer.to, tracked) && knownPaymentToken(chain, transfer.token));

  if (market && sentNfts.length > 0 && receivedPayments.length > 0) return `${chain.name} NFT sold`;
  if (market && receivedNfts.length > 0 && sentPayments.length > 0) return `${chain.name} NFT bought`;
  if (market && sentNfts.length > 0) return `${chain.name} NFT marketplace transfer`;
  if (market && receivedNfts.length > 0) return `${chain.name} NFT received via marketplace`;
  if (market && tokenTransfers.length > 0) return `${chain.name} marketplace payment/fee`;
  if (nftTransfers.length > 0) return `${chain.name} NFT transfer`;
  return `${chain.name} token transfer`;
}

function trackedWalletSummary(transfers, tracked) {
  const addresses = new Set();
  for (const transfer of transfers) {
    if (isTracked(transfer.from, tracked)) addresses.add(transfer.from);
    if (isTracked(transfer.to, tracked)) addresses.add(transfer.to);
  }
  return [...addresses].map((address) => `${html(trackedLabel(address, tracked))} <code>${address}</code>`).join("\n");
}

async function nftSummary(chain, transfers, tracked) {
  const lines = [];
  for (const transfer of transfers.slice(0, 5)) {
    const meta = await tokenMeta(chain, transfer.token, "erc721");
    const direction = isTracked(transfer.from, tracked) ? "Sent NFT" : "Received NFT";
    lines.push(
      `${direction}: <a href="${chain.explorerAddress}${transfer.token}">${html(meta.name || meta.symbol)}</a> #${transfer.value.toString()}`,
    );
  }
  if (transfers.length > 5) lines.push(`NFT transfers: ${transfers.length}`);
  return lines.join("\n");
}

async function paymentSummary(chain, transfers, tracked) {
  const byToken = new Map();
  for (const transfer of transfers) {
    const delta = (isTracked(transfer.to, tracked) ? transfer.value : 0n) - (isTracked(transfer.from, tracked) ? transfer.value : 0n);
    if (delta === 0n) continue;
    byToken.set(transfer.token, (byToken.get(transfer.token) || 0n) + delta);
  }

  const lines = [];
  for (const [token, net] of byToken) {
    const meta = await tokenMeta(chain, token, "erc20");
    lines.push(`Net payment: <b>${html(formatNetAmount(net, meta))}</b>`);
  }
  return lines.join("\n");
}

async function broadcast(text) {
  if (config.discordWebhookUrl) {
    try {
      await sendDiscordMessage(text);
    } catch (err) {
      console.error(`[discord] ${err.message}`);
    }
  }

  const ids = new Set([...config.authorizedChatIds, ...state.authorizedChatIds]);
  for (const chatId of ids) {
    try {
      await sendMessage(chatId, text);
    } catch (err) {
      console.error(`[telegram] send to ${chatId}: ${err.message}`);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const telegramEnabled = config.telegramToken && !config.telegramToken.includes("REPLACE_ME");
  if (!telegramEnabled && !config.discordWebhookUrl) {
    throw new Error("Set TELEGRAM_BOT_TOKEN or DISCORD_WEBHOOK_URL in .env");
  }
  if (chains.length === 0) throw new Error("Set at least one RPC URL in .env");

  console.log(`[boot] chains=${chains.map((chain) => chain.key).join(", ")}`);
  console.log(`[boot] telegram=${telegramEnabled ? "enabled" : "disabled"} discord=${config.discordWebhookUrl ? "enabled" : "disabled"}`);
  if (config.discordWebhookUrl) {
    console.log(`[boot] discordMinSendIntervalMs=${config.discordMinSendIntervalMs} discordMaxQueueSize=${config.discordMaxQueueSize}`);
  }
  if (telegramEnabled) {
    console.log(`[boot] authorizedChats=${[...config.authorizedChatIds, ...state.authorizedChatIds].join(", ") || "first /start claims bot"}`);
  }

  await Promise.all(telegramEnabled ? [telegramLoop(), scanLoop()] : [scanLoop()]);
}

main().catch((err) => {
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
});
