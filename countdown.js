// 環境變數（在 Cloudflare 後台設定）
// DISCORD_TOKEN
// DISCORD_PUBLIC_KEY
// GUILD_ID
// CATEGORY_ID

// KV 繫結：COUNTDOWN_STORE

// 驗證 Discord 請求
async function verify(request, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const body = await request.clone().text();
  if (!signature || !timestamp || !body) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    hexToUint8(publicKey),
    { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' },
    false,
    ['verify']
  );
  return crypto.subtle.verify(
    'NODE-ED25519',
    key,
    hexToUint8(signature),
    encoder.encode(timestamp + body)
  );
}

function hexToUint8(hex) {
  return new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
}

// 回應 Discord
function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// KV 輔助
async function getAll(store) {
  const list = await store.list();
  const configs = [];
  for (const k of list.keys) {
    const v = await store.get(k.name);
    if (v) configs.push({ key: k.name, ...JSON.parse(v) });
  }
  return configs;
}

// Discord API 呼叫
async function discordApi(token, endpoint, method = 'GET', body = null) {
  const opt = {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }
  };
  if (body) opt.body = JSON.stringify(body);
  const res = await fetch(`https://discord.com/api/v10${endpoint}`, opt);
  if (!res.ok) {
    console.error(`API ${endpoint} failed: ${res.status} ${await res.text()}`);
    return null;
  }
  return res.json();
}

// 產生頻道名稱
function genName(cfg, now = new Date()) {
  const target = new Date(cfg.target_date + 'T00:00:00Z'); // 強制 UTC 午夜
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());

  const emoji = cfg.emoji || '📝';
  const prefix = cfg.prefix || '倒數';

  if (cfg.mode === 'countup') {
    // 計算從目標日到今天過了幾天（目標當天為第 0 天）
    const passed = Math.floor((today - targetDay) / 86400000);
    return `${emoji}${prefix}已過 ${passed} 天`;
  } else {
    // 倒數模式：距離目標還有幾天（目標當天為第 0 天，未來為負數）
    const diff = Math.ceil((targetDay - today) / 86400000);
    // 使用者希望看到負號，例如距離 7/12 還有 15 天時顯示「-15天」
    return `${emoji}${prefix}${diff > 0 ? -diff : diff}天`;
  }
}

// 處理斜線指令
async function handleInteraction(interaction, env) {
  const { data, member } = interaction;
  const cmd = data.name;
  const sub = data.options?.[0]?.name;

  // 權限檢查：必須有「管理伺服器」權限
  if (!member?.permissions || !(BigInt(member.permissions) & 0x20n)) {
    return reply({ type: 4, data: { content: '❌ 你需要「管理伺服器」權限才能使用。', flags: 64 } });
  }

  if (cmd === 'countdown' && sub === 'create') {
    const opts = data.options[0].options;
    const prefix = opts.find(o => o.name === 'prefix')?.value || '倒數';
    const targetDate = opts.find(o => o.name === 'target_date')?.value;
    const mode = opts.find(o => o.name === 'mode')?.value || 'countdown';
    const emoji = opts.find(o => o.name === 'emoji')?.value || '📝';

    const chName = genName({ prefix, target_date: targetDate, mode, emoji });
    const channel = await discordApi(env.DISCORD_TOKEN, `/guilds/${env.GUILD_ID}/channels`, 'POST', {
      name: chName,
      type: 0,
      parent_id: env.CATEGORY_ID
    });

    if (!channel) {
      return reply({ type: 4, data: { content: '❌ 建立頻道失敗，請檢查權限或類別 ID。', flags: 64 } });
    }

    await env.COUNTDOWN_STORE.put(channel.id, JSON.stringify({
      prefix, target_date: targetDate, mode, emoji
    }));

    return reply({ type: 4, data: { content: `✅ 已建立倒數頻道 <#${channel.id}>，目前名稱：${chName}`, flags: 64 } });
  }

  if (cmd === 'countdown' && sub === 'delete') {
    const chId = data.options[0].options.find(o => o.name === 'channel')?.value;
    const cfg = await env.COUNTDOWN_STORE.get(chId);
    if (!cfg) return reply({ type: 4, data: { content: '❌ 找不到該倒數頻道記錄。', flags: 64 } });

    await env.COUNTDOWN_STORE.delete(chId);
    await discordApi(env.DISCORD_TOKEN, `/channels/${chId}`, 'DELETE');
    return reply({ type: 4, data: { content: '🗑️ 已刪除倒數頻道與記錄。', flags: 64 } });
  }

  if (cmd === 'countdown' && sub === 'list') {
    const configs = await getAll(env.COUNTDOWN_STORE);
    if (configs.length === 0) return reply({ type: 4, data: { content: '📋 目前沒有任何倒數頻道。', flags: 64 } });
    const list = configs.map(c => `- <#${c.key}>：${c.prefix}（${c.target_date}，${c.mode === 'countup' ? '累計' : '倒數'}）`).join('\n');
    return reply({ type: 4, data: { content: `📋 **倒數頻道清單**\n${list}`, flags: 64 } });
  }

  return reply({ type: 4, data: { content: '未知指令。', flags: 64 } });
}

// 定時更新所有頻道
async function updateChannels(env) {
  const configs = await getAll(env.COUNTDOWN_STORE);
  const now = new Date();
  for (const c of configs) {
    const newName = genName(c, now);
    await discordApi(env.DISCORD_TOKEN, `/channels/${c.key}`, 'PATCH', { name: newName });
    // 避免 rate limit 簡單延遲 1 秒（頻道數量少時可省略）
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`Updated ${configs.length} channels.`);
}

export default {
  async fetch(request, env) {
    if (request.method === 'POST') {
      const ok = await verify(request, env.DISCORD_PUBLIC_KEY);
      if (!ok) return new Response('Invalid signature', { status: 401 });

      const interaction = await request.json();
      if (interaction.type === 1) return reply({ type: 1 }); // PING
      if (interaction.type === 2) return handleInteraction(interaction, env);
    }
    return new Response('Discord Countdown Worker OK');
  },

  async scheduled(event, env) {
    await updateChannels(env);
  }
};