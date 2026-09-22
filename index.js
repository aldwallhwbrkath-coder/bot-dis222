const {
    Client,
    GatewayIntentBits,
    Events,
    PermissionFlagsBits,
    Partials
} = require('discord.js');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config.json');
const { initializeTimeoutModeration } = require('./timeoutModeration');
const { initializeTicketSystem } = require('./ticketSystem');
const { initializeWelcomeSystem } = require('./welcomeSystem');
const { initializeOutOfTopic } = require('./outOfTopic');
const { initializeDailyStreakSystem } = require('./dailyStreakSystem');
const { initializeVoiceRoomSystem } = require('./voiceRoomSystem');

const token = process.env.DISCORD_TOKEN || config.token;
const LOCK_FILE = path.join(__dirname, '.bot.lock');
const DATA_DIR = path.join(__dirname, 'data');
const DATABASE_FILE = path.join(DATA_DIR, 'bot.sqlite');
const DELETE_COMMAND_ROLE_ID = '1122599432416923739';
const GIVE_POINTS_ROLE_ID = '1161399280637063239';
const SPAM_COOLDOWN_MS = 4_000;
const VOICE_REWARD_SECONDS = 60 * 60;
const VOICE_REWARD_POINTS = 10;
const MESSAGE_REWARD_INTERVAL = 50;
const MESSAGE_REWARD_POINTS = 10;
const LOGIN_RETRY_INITIAL_MS = 5_000;
const LOGIN_RETRY_MAX_MS = 60_000;

function isBotProcess(pid) {
    try {
        process.kill(pid, 0);
    } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
    }

    if (process.platform !== 'win32') return true;

    const taskList = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
    });
    const processName = taskList.split(',')[0].replace(/^"|"$/g, '').toLowerCase();
    return processName === 'node.exe' || processName === 'node';
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const database = new Database(DATABASE_FILE);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
    CREATE TABLE IF NOT EXISTS users (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 0,
        total_points_earned INTEGER NOT NULL DEFAULT 0,
        total_points_transferred INTEGER NOT NULL DEFAULT 0,
        total_messages INTEGER NOT NULL DEFAULT 0,
        total_voice_seconds INTEGER NOT NULL DEFAULT 0,
        rewarded_voice_hours INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 0,
        last_voice_reward_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS voice_sessions (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        from_user_id TEXT,
        to_user_id TEXT,
        amount INTEGER NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS level_history (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        level INTEGER NOT NULL,
        reached_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, level)
    );
`);
try {
    database.exec('ALTER TABLE users ADD COLUMN level INTEGER NOT NULL DEFAULT 0');
} catch (error) {
    if (!String(error.message).includes('duplicate column name')) throw error;
}
try {
    database.exec('ALTER TABLE voice_sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0');
} catch (error) {
    if (!String(error.message).includes('duplicate column name')) throw error;
}

const ensureUser = database.prepare(`
    INSERT INTO users (guild_id, user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO NOTHING
`);
const getUser = database.prepare('SELECT * FROM users WHERE guild_id = ? AND user_id = ?');
const updateUserActivity = database.prepare(`
    UPDATE users
    SET total_messages = total_messages + 1, updated_at = ?
    WHERE guild_id = ? AND user_id = ?
`);
const addPoints = database.prepare(`
    UPDATE users
    SET points = points + ?, total_points_earned = total_points_earned + ?, updated_at = ?
    WHERE guild_id = ? AND user_id = ?
`);
const addVoiceTime = database.prepare(`
    UPDATE users
    SET total_voice_seconds = total_voice_seconds + ?, updated_at = ?
    WHERE guild_id = ? AND user_id = ?
`);

function acquireProcessLock() {
    try {
        const existingPid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
        if (existingPid && existingPid !== process.pid) {
            if (isBotProcess(existingPid)) {
                throw new Error(`Another bot process is already running (PID ${existingPid}).`);
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'w' });
}

acquireProcessLock();
let shutdownStarted = false;
const releaseProcessLock = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
        if (Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Could not remove bot lock:', error);
    }
    closeDatabase();
};
process.once('exit', releaseProcessLock);
process.once('SIGINT', () => { releaseProcessLock(); process.exit(0); });
process.once('SIGTERM', () => { releaseProcessLock(); process.exit(0); });

if (!token || token === 'REPLACE_WITH_BOT_TOKEN') {
    throw new Error('Missing Discord bot token. Set DISCORD_TOKEN or add a local token to config.json.');
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages
    ],
    partials: [
        Partials.Channel
    ]
});

initializeTimeoutModeration(client, database, config);
initializeTicketSystem(client, database);
initializeWelcomeSystem(client, database, config);
initializeOutOfTopic(client, database);
const streakSystem = initializeDailyStreakSystem(client, database, config);
initializeVoiceRoomSystem(client, database, config);

const handledMessageIds = new Map();
const spamStateByUser = new Map();

const commands = new Map([
    ['hi', handleHiCommand],
    ['حذف', handleDeleteCommand],
    ['!نقاطي', handleBalanceCommand],
    ['!تحويل', handleTransferCommand],
    ['!تفاعل', handleActivityCommand],
    ['!ليفل', handleLevelCommand],
    ['!اعطيني', handleGivePointsCommand]
]);

async function deleteRecentMessages(message, amount) {
    const messages = await message.channel.messages.fetch({ limit: amount });
    const fourteenDays = 14 * 24 * 60 * 60 * 1000;
    const recentMessages = messages.filter(
        (item) => Date.now() - item.createdTimestamp < fourteenDays
    );
    const oldMessages = messages.filter(
        (item) => Date.now() - item.createdTimestamp >= fourteenDays
    );

    let deletedCount = 0;
    if (recentMessages.size > 0) {
        const deleted = await message.channel.bulkDelete(recentMessages, true);
        deletedCount += deleted.size;
    }

    if (oldMessages.size > 0) {
        const results = await Promise.allSettled(
            oldMessages.map((item) => item.delete())
        );
        deletedCount += results.filter((result) => result.status === 'fulfilled').length;
    }

    return deletedCount;
}

function now() {
    return Date.now();
}

function ensureGuildUser(guildId, userId) {
    const timestamp = now();
    ensureUser.run(guildId, userId, timestamp, timestamp);
    return getUser.get(guildId, userId);
}

function calculateLevel(user) {
    const messageLevels = Math.floor(user.total_messages / MESSAGE_REWARD_INTERVAL);
    const voiceLevels = Math.floor(user.total_voice_seconds / VOICE_REWARD_SECONDS);
    return messageLevels + voiceLevels;
}

function syncLevelInternal(guildId, userId) {
    const user = getUser.get(guildId, userId);
    if (!user) return [];

    const targetLevel = calculateLevel(user);
    if (targetLevel <= user.level) return [];

    const reachedAt = now();
    const newLevels = [];
    const insertLevel = database.prepare(`
        INSERT INTO level_history (guild_id, user_id, level, reached_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id, level) DO NOTHING
    `);

    for (let level = user.level + 1; level <= targetLevel; level += 1) {
        const result = insertLevel.run(guildId, userId, level, reachedAt);
        if (result.changes > 0) newLevels.push(level);
    }

    database.prepare(
        'UPDATE users SET level = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?'
    ).run(targetLevel, reachedAt, guildId, userId);
    return newLevels;
}

const syncLevel = database.transaction(syncLevelInternal);

const recordMessage = database.transaction((guildId, userId) => {
    const timestamp = now();
    ensureGuildUser(guildId, userId);
    updateUserActivity.run(timestamp, guildId, userId);

    const user = getUser.get(guildId, userId);
    if (user.total_messages % MESSAGE_REWARD_INTERVAL === 0) {
        addPoints.run(MESSAGE_REWARD_POINTS, MESSAGE_REWARD_POINTS, timestamp, guildId, userId);
        database.prepare(`
            INSERT INTO transactions (guild_id, to_user_id, amount, type, created_at)
            VALUES (?, ?, ?, 'message_reward', ?)
        `).run(guildId, userId, MESSAGE_REWARD_POINTS, timestamp);
        syncLevelInternal(guildId, userId);
        return MESSAGE_REWARD_POINTS;
    }

    syncLevelInternal(guildId, userId);
    return 0;
});

const transferPoints = database.transaction((guildId, senderId, receiverId, amount) => {
    const timestamp = now();
    const sender = ensureGuildUser(guildId, senderId);
    ensureGuildUser(guildId, receiverId);

    if (sender.points < amount) {
        throw new Error('INSUFFICIENT_FUNDS');
    }

    database.prepare(`
        UPDATE users
        SET points = points - ?, total_points_transferred = total_points_transferred + ?, updated_at = ?
        WHERE guild_id = ? AND user_id = ?
    `).run(amount, amount, timestamp, guildId, senderId);
    addPoints.run(amount, 0, timestamp, guildId, receiverId);
    database.prepare(`
        INSERT INTO transactions (guild_id, from_user_id, to_user_id, amount, type, created_at)
        VALUES (?, ?, ?, ?, 'transfer', ?)
    `).run(guildId, senderId, receiverId, amount, timestamp);

    return getUser.get(guildId, senderId);
});

const grantPoints = database.transaction((guildId, userId, amount) => {
    const timestamp = now();
    ensureGuildUser(guildId, userId);
    addPoints.run(amount, amount, timestamp, guildId, userId);
    database.prepare(`
        INSERT INTO transactions (guild_id, to_user_id, amount, type, created_at)
        VALUES (?, ?, ?, 'ministry_grant', ?)
    `).run(guildId, userId, amount, timestamp);

    return getUser.get(guildId, userId);
});

const startVoiceSession = database.transaction((guildId, userId, channelId) => {
    ensureGuildUser(guildId, userId);
    const existing = database.prepare(
        'SELECT * FROM voice_sessions WHERE guild_id = ? AND user_id = ?'
    ).get(guildId, userId);

    if (existing) {
        if (existing.channel_id === channelId) {
            checkpointVoiceSessionInternal(guildId, userId, now());
            return;
        }
        finishVoiceSessionInternal(guildId, userId, now());
    }

    database.prepare(`
        INSERT INTO voice_sessions (guild_id, user_id, channel_id, started_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
            channel_id = excluded.channel_id,
            started_at = excluded.started_at,
            last_seen_at = excluded.last_seen_at
    `).run(guildId, userId, channelId, now(), now());
});

function finishVoiceSessionInternal(guildId, userId, endedAt = now()) {
    const session = database.prepare(
        'SELECT * FROM voice_sessions WHERE guild_id = ? AND user_id = ?'
    ).get(guildId, userId);
    if (!session) return 0;

    const seconds = checkpointVoiceSessionInternal(guildId, userId, endedAt);
    database.prepare(
        'DELETE FROM voice_sessions WHERE guild_id = ? AND user_id = ?'
    ).run(guildId, userId);
    return seconds;
}

const finishVoiceSession = database.transaction(finishVoiceSessionInternal);

function checkpointVoiceSessionInternal(guildId, userId, checkpointAt = now()) {
    const session = database.prepare(
        'SELECT * FROM voice_sessions WHERE guild_id = ? AND user_id = ?'
    ).get(guildId, userId);
    if (!session) return 0;

    const seconds = Math.max(0, Math.floor((checkpointAt - session.started_at) / 1000));
    if (seconds === 0) {
        database.prepare(
            'UPDATE voice_sessions SET last_seen_at = ? WHERE guild_id = ? AND user_id = ?'
        ).run(checkpointAt, guildId, userId);
        return 0;
    }

    ensureGuildUser(guildId, userId);
    addVoiceTime.run(seconds, checkpointAt, guildId, userId);
    database.prepare(`
        UPDATE voice_sessions
        SET started_at = ?, last_seen_at = ?
        WHERE guild_id = ? AND user_id = ?
    `).run(checkpointAt, checkpointAt, guildId, userId);

    const user = getUser.get(guildId, userId);
    const earnedHours = Math.floor(user.total_voice_seconds / VOICE_REWARD_SECONDS);
    const newHours = earnedHours - user.rewarded_voice_hours;
    if (newHours > 0) {
        addPoints.run(
            newHours * VOICE_REWARD_POINTS,
            newHours * VOICE_REWARD_POINTS,
            checkpointAt,
            guildId,
            userId
        );
        database.prepare(`
            UPDATE users
            SET rewarded_voice_hours = ?, last_voice_reward_at = ?, updated_at = ?
            WHERE guild_id = ? AND user_id = ?
        `).run(earnedHours, checkpointAt, checkpointAt, guildId, userId);
        database.prepare(`
            INSERT INTO transactions (guild_id, to_user_id, amount, type, created_at)
            VALUES (?, ?, ?, 'voice_reward', ?)
        `).run(guildId, userId, newHours * VOICE_REWARD_POINTS, checkpointAt);
    }

    syncLevelInternal(guildId, userId);

    return seconds;
}

const checkpointVoiceSession = database.transaction(checkpointVoiceSessionInternal);

function formatVoiceTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}

function activityScore(user) {
    return user.total_messages + Math.floor(user.total_voice_seconds / 3600) * 50;
}

function closeDatabase() {
    if (!database.open) return;

    clearInterval(voiceHeartbeat);
    try {
        const sessions = database.prepare('SELECT guild_id, user_id FROM voice_sessions').all();
        for (const session of sessions) {
            finishVoiceSession(session.guild_id, session.user_id, now());
        }
    } finally {
        database.close();
    }
}

const voiceHeartbeat = setInterval(() => {
    const sessions = database.prepare('SELECT guild_id, user_id FROM voice_sessions').all();
    for (const session of sessions) {
        checkpointVoiceSession(session.guild_id, session.user_id, now());
    }
}, 60_000);
voiceHeartbeat.unref();

function trackableVoiceState(state) {
    return Boolean(state.channelId && state.member && !state.member.user.bot);
}

function syncGuildVoiceSessions(guild) {
    const activeUserIds = new Set();
    for (const state of guild.voiceStates.cache.values()) {
        if (!trackableVoiceState(state)) continue;
        activeUserIds.add(state.id);
        startVoiceSession(guild.id, state.id, state.channelId);
    }

    const storedSessions = database.prepare(
        'SELECT user_id, last_seen_at FROM voice_sessions WHERE guild_id = ?'
    ).all(guild.id);
    for (const session of storedSessions) {
        if (!activeUserIds.has(session.user_id)) {
            finishVoiceSession(guild.id, session.user_id, session.last_seen_at || now());
        }
    }
}

function parseCommand(content) {
    const match = content.match(/^(\S+)(?:\s+(.+))?$/u);
    if (!match) return null;

    return {
        name: match[1],
        args: match[2] ? match[2].trim().split(/\s+/u) : []
    };
}

function handleSpamMessage(message) {
    if (!message.guild || !message.member || message.author.bot) return false;

    const key = `${message.guild.id}:${message.author.id}`;
    const timestamp = Date.now();
    for (const [stateKey, state] of spamStateByUser) {
        if (timestamp - state.startedAt >= SPAM_COOLDOWN_MS) {
            spamStateByUser.delete(stateKey);
        }
    }
    const previous = spamStateByUser.get(key);

    if (!previous || timestamp - previous.startedAt >= SPAM_COOLDOWN_MS) {
        spamStateByUser.set(key, {
            startedAt: timestamp,
            messages: [{ id: message.id, channelId: message.channel.id }],
            warned: false
        });
        return false;
    }

    previous.messages.push({ id: message.id, channelId: message.channel.id });
    const botMember = message.guild.members.me;
    const permissions = botMember ? message.channel.permissionsFor(botMember) : null;
    let deletionTask = Promise.resolve();
    if (!permissions?.has(PermissionFlagsBits.ManageMessages)) {
        console.error(`[antispam] Missing Manage Messages permission in ${message.channel.id}.`);
    } else {
        const deletions = previous.messages
            .filter((item) => item.channelId === message.channel.id && item.id !== previous.messages[0].id)
            .map((item) => message.channel.messages.delete(item.id).catch((error) => {
                console.error(`[antispam] Could not delete message ${item.id}:`, error);
            }));
        deletionTask = Promise.allSettled(deletions).catch((error) => {
            console.error('[antispam] Deletion batch failed:', error);
        });
    }

    if (!previous.warned) {
        previous.warned = true;
        deletionTask.then(() => message.channel.send('يا حبيبي 😂')).catch((error) => {
            console.error('[antispam] Could not send warning:', error);
        });
    }

    return true;
}

function handleHiCommand(message) {
    return message.reply('Hello!');
}

async function handleBalanceCommand(message, args) {
    if (!message.guild || args.length !== 0) return;

    const user = ensureGuildUser(message.guild.id, message.author.id);
    await message.reply(`💰 رصيدك الحالي: ${user.points} نقطة.`);
}

async function handleGivePointsCommand(message, args) {
    if (!message.guild) return;

    if (!message.member?.roles.cache.has(GIVE_POINTS_ROLE_ID)) {
        await message.reply('❌ You do not have permission to use this command.');
        return;
    }

    const amount = Number(args[0]);
    if (args.length !== 1 || !Number.isInteger(amount) || amount < 1) {
        await message.reply('استخدم: !اعطيني amount');
        return;
    }

    grantPoints(message.guild.id, message.author.id, amount);
    await message.reply(
        `✅ تم إعطاء ${amount} نقطة من وزارة الداخلية إلى <@${message.author.id}>`
    );
}

async function handleTransferCommand(message, args) {
    if (!message.guild) return;

    const receiver = message.mentions.users.first();
    const amount = Number(args[1]);
    if (args.length !== 2 || !receiver || !Number.isInteger(amount) || amount < 1) {
        await message.reply('استخدم: !تحويل @user amount');
        return;
    }
    if (receiver.id === message.author.id) {
        await message.reply('لا يمكنك تحويل النقاط إلى نفسك.');
        return;
    }
    if (receiver.bot) {
        await message.reply('لا يمكن تحويل النقاط إلى بوت.');
        return;
    }

    try {
        const sender = transferPoints(message.guild.id, message.author.id, receiver.id, amount);
        await message.reply(
            `✅ تم تحويل ${amount} نقطة إلى <@${receiver.id}>.\n💰 رصيدك المتبقي: ${sender.points} نقطة.`
        );
    } catch (error) {
        if (error.message === 'INSUFFICIENT_FUNDS') {
            await message.reply('لا تملك نقاطًا كافية لإتمام التحويل.');
            return;
        }
        throw error;
    }
}

async function handleActivityCommand(message, args) {
    if (!message.guild || args.length !== 0) return;

    const users = database.prepare(`
        SELECT * FROM users
        WHERE guild_id = ? AND (total_messages > 0 OR total_voice_seconds > 0 OR total_points_earned > 0)
        ORDER BY (total_messages + (total_voice_seconds / 3600) * 50) DESC,
                 total_points_earned DESC,
                 total_messages DESC
        LIMIT 10
    `).all(message.guild.id);

    if (users.length === 0) {
        await message.reply('لا توجد بيانات نشاط بعد.');
        return;
    }

    const lines = ['🏆 **TOP 10 MOST ACTIVE MEMBERS**'];
    for (let index = 0; index < users.length; index += 1) {
        const user = users[index];
        const member = await message.guild.members.fetch(user.user_id).catch(() => null);
        const name = member ? member.displayName : `<@${user.user_id}>`;
        lines.push(
            `**#${index + 1} ${name}**\n` +
            `💬 Messages: ${user.total_messages}\n` +
            `🎙️ Voice Time: ${formatVoiceTime(user.total_voice_seconds)}\n` +
            `💰 Points Earned: ${user.total_points_earned}\n` +
            `📈 Activity Score: ${activityScore(user)}`
        );
    }

    await message.reply(lines.join('\n\n'));
}

async function handleLevelCommand(message, args) {
    if (!message.guild || args.length !== 0) return;

    const user = ensureGuildUser(message.guild.id, message.author.id);
    syncLevel(message.guild.id, message.author.id);
    const current = getUser.get(message.guild.id, message.author.id);

    await message.reply(
        `📈 مستواك الحالي: ${current.level}\n` +
        `💬 الرسائل: ${current.total_messages}\n` +
        `🎙️ وقت الصوت: ${formatVoiceTime(current.total_voice_seconds)}\n` +
        `كل ${MESSAGE_REWARD_INTERVAL} رسالة أو كل ساعة صوت ترفع المستوى.`
    );
}

async function handleDeleteCommand(message, args) {
    if (!message.guild) return;

    const amount = Number(args[0]);
    if (args.length !== 1 || !Number.isInteger(amount) || amount < 1 || amount > 100) {
        await message.reply('استخدم رقمًا صحيحًا من 1 إلى 100.');
        return;
    }

    if (!message.member?.roles.cache.has(DELETE_COMMAND_ROLE_ID)) {
        await message.reply('❌ You do not have permission to use this command.');
        return;
    }

    const botMember = message.guild.members.me;
    const botPermissions = botMember ? message.channel.permissionsFor(botMember) : null;
    if (!botPermissions?.has(PermissionFlagsBits.ManageMessages)) {
        await message.reply('لا أملك صلاحية حذف الرسائل في هذه القناة.');
        return;
    }

    try {
        const deletedCount = await deleteRecentMessages(message, amount);
        await message.channel.send(`تم حذف ${deletedCount} رسالة.`);
    } catch (error) {
        console.error('Message deletion error:', error);
        await message.channel.send('تعذر حذف الرسائل. تحقق من الصلاحيات وحاول مرة أخرى.');
    }
}

function routeCommand(message) {
    const parsed = parseCommand(message.content.trim());
    if (!parsed) return false;

    const handler = commands.get(parsed.name);
    if (!handler) return false;

    Promise.resolve(handler(message, parsed.args)).catch((error) => {
        console.error(`Command "${parsed.name}" failed:`, error);
    });
    return true;
}

function isGreetingMessage(content) {
    const normalized = content
        .normalize('NFKC')
        .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
        .replace(/[إأآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ـ/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return /^(?:ال)?سلام\s+عليكم[!؟،.,]*$/i.test(normalized);
}

async function handleBotLoveReply(message) {
    if (message.content !== 'بحبك' || !message.reference?.messageId) return;

    const referencedMessage = message.reference.messageId === message.id
        ? null
        : (message.channel.messages.cache.get(message.reference.messageId)
            || await message.channel.messages.fetch(message.reference.messageId).catch(() => null));
    if (!referencedMessage || referencedMessage.author.id !== client.user?.id) return;

    await message.reply('ماشي يا اسطى حاضر 🙂');
}

async function registerStreakCommands() {
    for (const guild of client.guilds.cache.values()) {
        const commands = await guild.commands.fetch();
        const command = commands.find((item) => item.name === streakSystem.commandName);
        if (command) {
            await command.edit({
                name: streakSystem.commandName,
                description: 'Activate the daily streak system'
            });
        } else {
            await guild.commands.create({
                name: streakSystem.commandName,
                description: 'Activate the daily streak system'
            });
        }
    }
}

client.once(Events.ClientReady, () => {
    console.log(`Logged in as ${client.user.tag}`);
    registerStreakCommands().catch((error) => {
        console.error('[streak] Slash command registration failed:', error);
    });
    const users = database.prepare('SELECT guild_id, user_id FROM users').all();
    for (const user of users) {
        syncLevel(user.guild_id, user.user_id);
    }
    for (const guild of client.guilds.cache.values()) {
        syncGuildVoiceSessions(guild);
    }
});

client.on(Events.Error, (error) => {
    console.error('[discord] Client error:', error);
});
client.on(Events.Warn, (message) => {
    console.warn('[discord] Warning:', message);
});
client.on(Events.ShardReconnecting, (id) => {
    console.warn(`[discord] Gateway shard ${id} is reconnecting.`);
});
client.on(Events.ShardDisconnect, (event, id) => {
    console.warn(`[discord] Gateway shard ${id} disconnected (code ${event.code}).`);
});
client.on(Events.ShardReady, (id) => {
    console.log(`[discord] Gateway shard ${id} is ready.`);
});
client.on(Events.ShardResume, (id, replayedEvents) => {
    console.log(`[discord] Gateway shard ${id} resumed (${replayedEvents} events replayed).`);
});
client.on(Events.Invalidated, () => {
    console.error('[discord] Session invalidated; the token or bot configuration must be fixed before reconnecting.');
    releaseProcessLock();
    process.exit(1);
});
client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    streakSystem.handleCommand(interaction).catch((error) => {
        console.error('[streak] Slash command failed:', error);
        if (!interaction.replied && !interaction.deferred) {
            interaction.reply({ content: 'تعذر تنفيذ الأمر.', ephemeral: true }).catch(() => {});
        }
    });
});
process.on('unhandledRejection', (error) => {
    console.error('[process] Unhandled rejection; supervisor should restart the bot:', error);
    releaseProcessLock();
    process.exit(1);
});
process.on('uncaughtException', (error) => {
    console.error('[process] Uncaught exception; supervisor should restart the bot:', error);
    releaseProcessLock();
    process.exit(1);
});

client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    if (handledMessageIds.has(message.id)) return;
    handledMessageIds.set(message.id, Date.now());
    if (handledMessageIds.size > 1_000) {
        const oldestId = handledMessageIds.keys().next().value;
        handledMessageIds.delete(oldestId);
    }

    handleBotLoveReply(message).catch((error) => {
        console.error('Bot reply handler failed:', error);
    });

    if (isGreetingMessage(message.content)) {
        message.reply('وعليكم السلام ورحمة الله وبركاته').catch((error) => {
            console.error('Greeting reply failed:', error);
        });
    }

    if (handleSpamMessage(message)) return;

    if (message.guild) {
        const reward = recordMessage(message.guild.id, message.author.id);
        if (reward > 0) {
            console.log(`[rewards] ${message.author.tag} earned ${reward} points for messages.`);
        }
    }

    routeCommand(message);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (oldState.channelId === newState.channelId) return;
    const member = newState.member || oldState.member;
    if (!member || member.user.bot || !newState.guild) return;

    if (oldState.channelId) {
        const seconds = finishVoiceSession(newState.guild.id, member.id, now());
        if (seconds > 0) {
            console.log(`[activity] ${member.user.tag} left voice after ${seconds}s.`);
        }
    }
    if (newState.channelId) {
        startVoiceSession(newState.guild.id, member.id, newState.channelId);
        console.log(`[activity] ${member.user.tag} joined voice.`);
    }
});

async function connectWithRetry() {
    let retryDelay = LOGIN_RETRY_INITIAL_MS;

    while (!shutdownStarted) {
        try {
            await client.login(token);
            return;
        } catch (error) {
            console.error(`[discord] Login failed; retrying in ${retryDelay / 1000}s:`, error);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            retryDelay = Math.min(retryDelay * 2, LOGIN_RETRY_MAX_MS);
        }
    }
}

connectWithRetry().catch((error) => {
    console.error('[discord] Connection supervisor stopped unexpectedly:', error);
    releaseProcessLock();
    process.exit(1);
});
