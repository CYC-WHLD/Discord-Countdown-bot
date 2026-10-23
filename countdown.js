// ============================================================================
// Discord Countdown Bot - Cloudflare Worker（优化版）
// 功能：时区统一 / KV 前缀迁移 / Deferred Response / 智能命名 / 404 清理
// ============================================================================

const KV_PREFIX = 'cd:';
const DEFAULT_TZ = 'Asia/Taipei';

// ---------- Ed25519 签名验证（带 key 缓存） ----------
let cachedVerifyKey = null;
let cachedVerifyKeyHex = null;

function hexToUint8(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

async function getVerifyKey(publicKey) {
  if (cachedVerifyKey && cachedVerifyKeyHex === publicKey) return cachedVerifyKey;
  cachedVerifyKey = await crypto.subtle.importKey(
    'raw',
    hexToUint8(publicKey),
    { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' },
    false,
    ['verify']
  );
  cachedVerifyKeyHex = publicKey;
  return cachedVerifyKey;
}

async function verify(request, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp) return false;

  const body = await request.clone().text();
  if (!body) return false;

  const key = await getVerifyKey(publicKey);
  const encoder = new TextEncoder();
  return crypto.subtle.verify(
    'NODE-ED25519',
    key,
    hexToUint8(signature),
    encoder.encode(timestamp + body)
  );
}

// ---------- 基础工具 ----------
function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function isValidDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch { return false; }
}

// 将 Date 转成指定时区的 YYYY-MM-DD
function formatTz(date, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

// 两日期相差天数（to - from），正数表示 to 在未来
function daysBetween(fromStr, toStr) {
  const a = Date.UTC(...fromStr.split('-').map(Number));
  const b = Date.UTC(...toStr.split('-').map(Number));
  return Math.round((b - a) / 86400000);
}

// Discord 频道名清理：控制字符、多空格、100 字符上限
function clampName(name) {
  let cleaned = String(name)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > 100) cleaned = cleaned.slice(0, 100).trim();
  if (!cleaned) cleaned = 'countdown';
  return cleaned;
}

// ---------- 智能命名（核心逻辑） ----------
function genName(cfg, now = new Date()) {
  const tz = cfg.timezone || DEFAULT_TZ;
  const targetStr = cfg.target_date;
  const todayStr = formatTz(now, tz);
  const diff = daysBetween(todayStr, targetStr); // 未来为正、过去为负
  const emoji = cfg.emoji || '📝';
  const prefix = cfg.prefix || '倒數';
  const abs = Math.abs(diff);

  if (cfg.mode === 'countup') {
    if (diff < 0)  return clampName(`${emoji}${prefix}已過 ${abs} 天`);
    if (diff === 0) return clampName(`${emoji}${prefix}就是今天`);
    return clampName(`${emoji}${prefix}還有 ${abs} 天`);
  }

  // countdown 模式
  const hasCountdownWord = /倒數|倒数/.test(prefix);
  if (diff > 0) {
    const word = hasCountdownWord ? '' : '倒數 ';
    return clampName(`${emoji}${prefix}${word}${abs} 天`);
  }
  if (diff === 0) return clampName(`${emoji}${prefix}就是今天`);
  return clampName(`${emoji}${prefix}已過 ${abs} 天`);
}

// ---------- Discord API ----------
async function discordApi(token, endpoint, method = 'GET', body = null) {
  const opt = {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }
  };
  if (body) opt.body = JSON.stringify(body);
  const res = await fetch(`https://discord.com/api/v10${endpoint}`, opt);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) console.error(`API ${method} ${endpoint} failed: ${res.status}`, data);
  return { ok: res.ok, status: res.status, data };
}

// 更新 Deferred 消息（type 5 之后用）
async function patchOriginal(interaction, env, payload) {
  const appId = interaction.application_id;
  const token = interaction.token;
  return fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// ---------- KV 操作（含新旧格式兼容） ----------
async function getAll(store) {
  const configs = [];
  const seen = new Set();

  // 新前缀
  const newList = await store.list({ prefix: KV_PREFIX });
  for (const k of newList.keys) {
    const v = await store.get(k.name);
    const cfg = safeParse(v);
    if (cfg) {
      const id = k.name.slice(KV_PREFIX.length);
      configs.push({ key: id, ...cfg, _newFormat: true });
      seen.add(id);
    }
  }

  // 旧格式（兼容你现有的三笔数据）
  const oldList = await store.list();
  for (const k of oldList.keys) {
    if (k.name.startsWith(KV_PREFIX)) continue;
    if (seen.has(k.name)) continue;
    const v = await store.get(k.name);
    const cfg = safeParse(v);
    if (cfg) configs.push({ key: k.name, ...cfg, _newFormat: false });
  }

  return configs;
}

async function getConfig(store, channelId) {
  const v = await store.get(KV_PREFIX + channelId);
  const cfg = safeParse(v);
  if (cfg) return { ...cfg, _newFormat: true };

  const v2 = await store.get(channelId);
  const cfg2 = safeParse(v2);
  if (cfg2) return { ...cfg2, _newFormat: false };

  return null;
}

async function putConfig(store, channelId, cfg, migrateOld = false) {
  await store.put(KV_PREFIX + channelId, JSON.stringify(cfg));
  if (migrateOld) await store.delete(channelId);
}

async function deleteConfig(store, channelId) {
  await store.delete(KV_PREFIX + channelId);
  await store.delete(channelId);
}

// ---------- Embed 辅助 ----------
const COLORS = { success: 0x22c55e, error: 0xef4444, info: 0x3b82f6, warn: 0xf59e0b };

function embed(color, title, description = null, fields = null) {
  const e = { color, timestamp: new Date().toISOString() };
  if (title) e.title = title;
  if (description) e.description = description;
  if (fields) e.fields = fields;
  return e;
}

// ---------- 权限检查 ----------
function hasManageGuild(member) {
  try {
    if (!member?.permissions) return false;
    return (BigInt(member.permissions) & 0x20n) === 0x20n;
  } catch { return false; }
}

// ---------- /countdown create ----------
async function handleCreate(interaction, env, ctx) {
  const opts = interaction.data.options[0].options || [];
  const getOpt = (n) => opts.find(o => o.name === n)?.value;

  const prefix = (getOpt('prefix') || '倒數').trim();
  const targetDate = getOpt('target_date');
  const mode = getOpt('mode') || 'countdown';
  const emoji = getOpt('emoji') || '📝';
  const tz = getOpt('timezone') || DEFAULT_TZ;

  if (!isValidDate(targetDate)) {
    return reply({
      type: 4,
      data: {
        embeds: [embed(COLORS.error, '日期格式錯誤', '請使用 `YYYY-MM-DD` 格式，例如 `2026-07-13`。')],
        flags: 64
      }
    });
  }

  if (!isValidTimezone(tz)) {
    return reply({
      type: 4,
      data: {
        embeds: [embed(COLORS.error, '時區錯誤', `無效的時區：\`${tz}\`\n請使用 IANA 名稱，例如 \`Asia/Taipei\`。`)],
        flags: 64
      }
    });
  }

  const initialName = genName({ prefix, target_date: targetDate, mode, emoji, timezone: tz });

  ctx.waitUntil((async () => {
    try {
      const r = await discordApi(env.DISCORD_TOKEN, `/guilds/${env.GUILD_ID}/channels`, 'POST', {
        name: initialName,
        type: 0,
        parent_id: env.CATEGORY_ID
      });

      if (!r.ok) {
        const msg = r.status === 403
          ? 'Bot 缺少「管理頻道」權限，或 `CATEGORY_ID` 錯誤。'
          : `HTTP ${r.status}`;
        await patchOriginal(interaction, env, {
          embeds: [embed(COLORS.error, '建立失敗', msg)]
        });
        return;
      }

      const channel = r.data;
      await putConfig(env.COUNTDOWN_STORE, channel.id,
        { prefix, target_date: targetDate, mode, emoji, timezone: tz });

      await patchOriginal(interaction, env, {
        embeds: [embed(COLORS.success, '✅ 倒數頻道已建立',
          `頻道：<#${channel.id}>\n名稱：\`${initialName}\``,
          [
            { name: '模式', value: mode === 'countup' ? '累計' : '倒數', inline: true },
            { name: '目標日期', value: targetDate, inline: true },
            { name: '時區', value: tz, inline: true }
          ]
        )]
      });
    } catch (e) {
      console.error(e);
      await patchOriginal(interaction, env, {
        embeds: [embed(COLORS.error, '未預期錯誤', String(e?.message || e))]
      });
    }
  })());

  return reply({ type: 5 });
}

// ---------- /countdown delete ----------
async function handleDelete(interaction, env) {
  const channelId = interaction.data.options[0].options.find(o => o.name === 'channel').value;
  const cfg = await getConfig(env.COUNTDOWN_STORE, channelId);

  if (!cfg) {
    return reply({
      type: 4,
      data: {
        embeds: [embed(COLORS.error, '找不到記錄', `<#${channelId}> 不在倒數清單中。`)],
        flags: 64
      }
    });
  }

  // 先删频道；404 表示频道已不存在，可直接清 KV
  const r = await discordApi(env.DISCORD_TOKEN, `/channels/${channelId}`, 'DELETE');
  if (!r.ok && r.status !== 404) {
    return reply({
      type: 4,
      data: {
        embeds: [embed(COLORS.error, '刪除頻道失敗',
          r.status === 403 ? 'Bot 缺少「管理頻道」權限。' : `HTTP ${r.status}`)],
        flags: 64
      }
    });
  }

  await deleteConfig(env.COUNTDOWN_STORE, channelId);

  return reply({
    type: 4,
    data: {
      embeds: [embed(COLORS.success, '🗑️ 已刪除', `頻道 <#${channelId}> 與設定已清除。`)],
      flags: 64
    }
  });
}

// ---------- /countdown list ----------
async function handleList(interaction, env) {
  const configs = await getAll(env.COUNTDOWN_STORE);

  if (configs.length === 0) {
    return reply({
      type: 4,
      data: {
        embeds: [embed(COLORS.info, '📋 倒數頻道清單', '目前沒有任何倒數頻道。')],
        flags: 64
      }
    });
  }

  const shown = configs.slice(0, 25);
  const fields = shown.map(c => {
    const tz = c.timezone || DEFAULT_TZ;
    const diff = daysBetween(formatTz(new Date(), tz), c.target_date);
    const modeLabel = c.mode === 'countup' ? '累計' : '倒數';
    const status = diff > 0 ? `還有 ${diff} 天` : diff === 0 ? '就是今天' : `已過 ${-diff} 天`;
    return {
      name: `<#${c.key}>`,
      value: `\`${c.prefix}\` · ${c.target_date} · ${modeLabel} · ${status}`,
      inline: false
    };
  });

  const desc = configs.length > 25
    ? `共 ${configs.length} 個，僅顯示前 25 個。`
    : `共 ${configs.length} 個倒數頻道。`;

  return reply({
    type: 4,
    data: {
      embeds: [embed(COLORS.info, '📋 倒數頻道清單', desc, fields)],
      flags: 64
    }
  });
}

// ---------- /countdown edit ----------
async function handleEdit(interaction, env, ctx) {
  const opts = interaction.data.options[0].options || [];
  const getOpt = (n) => opts.find(o => o.name === n)?.value;

  const channelId = getOpt('channel');
  const cfg = await getConfig(env.COUNTDOWN_STORE, channelId);

  if (!cfg) {
    return reply({
      type: 4,
      data: {
        embeds: [embed(COLORS.error, '找不到記錄', `<#${channelId}> 不在倒數清單中。`)],
        flags: 64
      }
    });
  }

  const newPrefix = getOpt('prefix');
  const newTarget = getOpt('target_date');
  const newMode = getOpt('mode');
  const newEmoji = getOpt('emoji');
  const newTz = getOpt('timezone');

  if (newTarget && !isValidDate(newTarget)) {
    return reply({
      type: 4,
      data: {
        embeds: [embed(COLORS.error, '日期格式錯誤', '請使用 `YYYY-MM-DD` 格式。')],
        flags: 64
      }
    });
  }
  if (newTz && !isValidTimezone(newTz)) {
    return reply({
      type: 4,
      data: {
        embeds: [embed(COLORS.error, '時區錯誤', `無效的時區：\`${newTz}\``)],
        flags: 64
      }
    });
  }

  const merged = {
    prefix: newPrefix ?? cfg.prefix,
    target_date: newTarget ?? cfg.target_date,
    mode: newMode ?? cfg.mode,
    emoji: newEmoji ?? cfg.emoji,
    timezone: newTz ?? cfg.timezone ?? DEFAULT_TZ
  };

  const newName = genName(merged);

  ctx.waitUntil((async () => {
    try {
      const r = await discordApi(env.DISCORD_TOKEN, `/channels/${channelId}`, 'PATCH', { name: newName });
      if (!r.ok) {
        await patchOriginal(interaction, env, {
          embeds: [embed(COLORS.error, '更新頻道失敗', `HTTP ${r.status}`)]
        });
        return;
      }
      await putConfig(env.COUNTDOWN_STORE, channelId, merged, !cfg._newFormat);
      await patchOriginal(interaction, env, {
        embeds: [embed(COLORS.success, '✅ 已更新',
          `頻道：<#${channelId}>\n新名稱：\`${newName}\``,
          [
            { name: '模式', value: merged.mode === 'countup' ? '累計' : '倒數', inline: true },
            { name: '目標日期', value: merged.target_date, inline: true },
            { name: '時區', value: merged.timezone, inline: true }
          ]
        )]
      });
    } catch (e) {
      console.error(e);
      await patchOriginal(interaction, env, {
        embeds: [embed(COLORS.error, '未預期錯誤', String(e?.message || e))]
      });
    }
  })());

  return reply({ type: 5 });
}

// ---------- /countdown refresh ----------
async function handleRefresh(interaction, env, ctx) {
  const opts = interaction.data.options[0].options || [];
  const channelId = opts.find(o => o.name === 'channel')?.value;

  // 单个刷新
  if (channelId) {
    const cfg = await getConfig(env.COUNTDOWN_STORE, channelId);
    if (!cfg) {
      return reply({
        type: 4,
        data: {
          embeds: [embed(COLORS.error, '找不到記錄', `<#${channelId}> 不在倒數清單中。`)],
          flags: 64
        }
      });
    }

    ctx.waitUntil((async () => {
      try {
        const name = genName(cfg);
        const r = await discordApi(env.DISCORD_TOKEN, `/channels/${channelId}`, 'PATCH', { name });
        if (!r.ok) {
          await patchOriginal(interaction, env, {
            embeds: [embed(COLORS.error, '刷新失敗', `HTTP ${r.status}`)]
          });
          return;
        }
        await patchOriginal(interaction, env, {
          embeds: [embed(COLORS.success, '🔄 已刷新', `<#${channelId}> → \`${name}\``)]
        });
      } catch (e) {
        console.error(e);
        await patchOriginal(interaction, env, {
          embeds: [embed(COLORS.error, '未預期錯誤', String(e?.message || e))]
        });
      }
    })());

    return reply({ type: 5 });
  }

  // 全部刷新
  ctx.waitUntil((async () => {
    try {
      const configs = await getAll(env.COUNTDOWN_STORE);

      if (configs.length > 30) {
        await patchOriginal(interaction, env, {
          embeds: [embed(COLORS.warn, '頻道過多',
            `共 ${configs.length} 個頻道，請改用 \`/countdown refresh channel:<#>\` 分批刷新，或等待每日自動更新。`)]
        });
        return;
      }

      let okCount = 0, cleaned = 0, failed = 0;
      for (const c of configs) {
        const name = genName(c);
        const r = await discordApi(env.DISCORD_TOKEN, `/channels/${c.key}`, 'PATCH', { name });
        if (r.ok) {
          okCount++;
          if (!c._newFormat) {
            await putConfig(env.COUNTDOWN_STORE, c.key, {
              prefix: c.prefix, target_date: c.target_date, mode: c.mode,
              emoji: c.emoji, timezone: c.timezone || DEFAULT_TZ
            }, true);
          }
        } else if (r.status === 404) {
          await deleteConfig(env.COUNTDOWN_STORE, c.key);
          cleaned++;
        } else {
          failed++;
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      await patchOriginal(interaction, env, {
        embeds: [embed(COLORS.success, '🔄 全部刷新完成',
          `成功：${okCount}\n自動清理（頻道已刪）：${cleaned}\n失敗：${failed}`)]
      });
    } catch (e) {
      console.error(e);
      await patchOriginal(interaction, env, {
        embeds: [embed(COLORS.error, '未預期錯誤', String(e?.message || e))]
      });
    }
  })());

  return reply({ type: 5 });
}

// ---------- /countdown info ----------
async function handleInfo(interaction, env) {
  const channelId = interaction.data.options[0].options.find(o => o.name === 'channel').value;
  const cfg = await getConfig(env.COUNTDOWN_STORE, channelId);

  if (!cfg) {
    return reply({
      type: 4,
      data: {
        embeds: [embed(COLORS.error, '找不到記錄', `<#${channelId}> 不在倒數清單中。`)],
        flags: 64
      }
    });
  }

  const tz = cfg.timezone || DEFAULT_TZ;
  const diff = daysBetween(formatTz(new Date(), tz), cfg.target_date);
  const currentName = genName(cfg);
  const status = diff > 0 ? `還有 ${diff} 天` : diff === 0 ? '就是今天' : `已過 ${-diff} 天`;

  return reply({
    type: 4,
    data: {
      embeds: [embed(COLORS.info, '📊 頻道詳細資訊', null, [
        { name: '頻道', value: `<#${channelId}>`, inline: false },
        { name: '前綴', value: `\`${cfg.prefix}\``, inline: true },
        { name: '目標日期', value: cfg.target_date, inline: true },
        { name: '模式', value: cfg.mode === 'countup' ? '累計' : '倒數', inline: true },
        { name: '時區', value: tz, inline: true },
        { name: '剩餘/已過', value: status, inline: true },
        { name: '目前名稱', value: `\`${currentName}\``, inline: false }
      ])],
      flags: 64
    }
  });
}

// ---------- 指令路由 ----------
async function handleInteraction(interaction, env, ctx) {
  if (!hasManageGuild(interaction.member)) {
    return reply({
      type: 4,
      data: {
        embeds: [embed(COLORS.error, '權限不足', '你需要「管理伺服器」權限才能使用此指令。')],
        flags: 64
      }
    });
  }

  const cmd = interaction.data.name;
  const sub = interaction.data.options?.[0]?.name;

  if (cmd !== 'countdown') {
    return reply({
      type: 4,
      data: { embeds: [embed(COLORS.error, '未知指令', `\`${cmd}\``)], flags: 64 }
    });
  }

  switch (sub) {
    case 'create':  return handleCreate(interaction, env, ctx);
    case 'delete':  return handleDelete(interaction, env);
    case 'list':    return handleList(interaction, env);
    case 'edit':    return handleEdit(interaction, env, ctx);
    case 'refresh': return handleRefresh(interaction, env, ctx);
    case 'info':    return handleInfo(interaction, env);
    default:
      return reply({
        type: 4,
        data: { embeds: [embed(COLORS.error, '未知子指令', `\`${sub}\``)], flags: 64 }
      });
  }
}

// ---------- 定时更新（含旧数据迁移 + 404 清理） ----------
async function updateChannels(env) {
  const configs = await getAll(env.COUNTDOWN_STORE);
  const now = new Date();
  let ok = 0, cleaned = 0, failed = 0;

  for (const c of configs) {
    try {
      // 旧格式自动迁移成 cd:xxx
      if (!c._newFormat) {
        await putConfig(env.COUNTDOWN_STORE, c.key, {
          prefix: c.prefix,
          target_date: c.target_date,
          mode: c.mode,
          emoji: c.emoji,
          timezone: c.timezone || DEFAULT_TZ
        }, true);
      }

      const name = genName(c, now);
      const r = await discordApi(env.DISCORD_TOKEN, `/channels/${c.key}`, 'PATCH', { name });

      if (r.ok) ok++;
      else if (r.status === 404) {
        await deleteConfig(env.COUNTDOWN_STORE, c.key);
        cleaned++;
      } else failed++;
    } catch (e) {
      console.error(`update ${c.key} failed:`, e);
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[scheduled] total=${configs.length} ok=${ok} cleaned=${cleaned} failed=${failed}`);
}

// ---------- 主入口 ----------
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'POST') {
      const ok = await verify(request, env.DISCORD_PUBLIC_KEY);
      if (!ok) return new Response('Invalid signature', { status: 401 });

      const interaction = await request.json();
      if (interaction.type === 1) return reply({ type: 1 });
      if (interaction.type === 2) return handleInteraction(interaction, env, ctx);
    }
    return new Response('Discord Countdown Worker OK', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateChannels(env));
  }
};
