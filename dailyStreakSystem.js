const { Events } = require('discord.js');

const STREAK_CHANNEL_ID = '1111983965415424110';
const STREAK_ROLE_ID = '1161399280637063239';
const STREAK_COMMAND_NAME = 'streak';
const LOSS_MESSAGE = 'ولك الستريكككك ولك الستريككككك';
const REMINDER_MESSAGE = 'تذكير: لم تكمل ستريك اليوم بعد. أرسل صورة أو فيديو في قناة الستريك قبل منتصف الليل.';
const CHECK_INTERVAL_MS = 60_000;
const REMINDER_HOUR = 22;

function initializeDailyStreakSystem(client, database, config = {}) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS daily_streak_settings (
            guild_id TEXT PRIMARY KEY,
            active INTEGER NOT NULL DEFAULT 0,
            activated_at INTEGER
        )
    `);
    const timezone = config.timezone || config.serverTimezone || process.env.SERVER_TIMEZONE || 'Asia/Baghdad';
    const getSetting = database.prepare(
        'SELECT * FROM daily_streak_settings WHERE guild_id = ?'
    );
    const activateStreak = database.transaction((guildId, timestamp) => {
        database.prepare('DELETE FROM daily_streaks WHERE guild_id = ?').run(guildId);
        database.prepare(`
            INSERT INTO daily_streak_settings (guild_id, active, activated_at)
            VALUES (?, 1, ?)
            ON CONFLICT(guild_id) DO UPDATE SET active = 1, activated_at = excluded.activated_at
        `).run(guildId, timestamp);
    });

    database.exec(`
        CREATE TABLE IF NOT EXISTS daily_streaks (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            current_streak INTEGER NOT NULL DEFAULT 0,
            last_completed_date TEXT,
            completed_today INTEGER NOT NULL DEFAULT 0,
            warning_sent_date TEXT,
            loss_notified_date TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (guild_id, user_id)
        )
    `);

    const getStreak = database.prepare(
        'SELECT * FROM daily_streaks WHERE guild_id = ? AND user_id = ?'
    );
    const getAllStreaks = database.prepare('SELECT * FROM daily_streaks');
    const insertStreak = database.prepare(`
        INSERT INTO daily_streaks (guild_id, user_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO NOTHING
    `);
    const updateStreak = database.prepare(`
        UPDATE daily_streaks
        SET current_streak = ?, last_completed_date = ?, completed_today = ?,
            warning_sent_date = ?, loss_notified_date = ?, updated_at = ?
        WHERE guild_id = ? AND user_id = ?
    `);

    function localDateParts(timestamp = Date.now()) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            hourCycle: 'h23'
        }).formatToParts(new Date(timestamp));
        return Object.fromEntries(parts
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value]));
    }

    function currentDateKey(timestamp = Date.now()) {
        const parts = localDateParts(timestamp);
        return `${parts.year}-${parts.month}-${parts.day}`;
    }

    function previousDateKey(dateKey) {
        const date = new Date(`${dateKey}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() - 1);
        return date.toISOString().slice(0, 10);
    }

    function isValidMedia(message) {
        return message.attachments.some((attachment) => {
            if (attachment.contentType?.startsWith('image/')) return true;
            if (attachment.contentType?.startsWith('video/')) return true;
            return /\.(?:apng|avif|gif|jpe?g|png|webp|mp4|mov|webm|mkv)$/iu.test(
                new URL(attachment.url).pathname
            );
        });
    }

    function isActive(guildId) {
        return getSetting.get(guildId)?.active === 1;
    }

    async function handleCommand(interaction) {
        if (!interaction.isChatInputCommand() || interaction.commandName !== STREAK_COMMAND_NAME) {
            return false;
        }

        if (!interaction.guild) {
            await interaction.reply({ content: 'هذا الأمر متاح داخل السيرفر فقط.', ephemeral: true });
            return true;
        }

        if (!interaction.member?.roles?.cache?.has(STREAK_ROLE_ID)) {
            await interaction.reply({ content: '❌ لا تملك صلاحية تفعيل الستريك.', ephemeral: true });
            return true;
        }

        activateStreak(interaction.guild.id, Date.now());
        await interaction.reply(`✅ تم تفعيل الستريك في <#${STREAK_CHANNEL_ID}>. يبدأ كل مستخدم من ستريك 1 عند أول صورة أو فيديو.`);
        return true;
    }

    function reconcileStreak(streak, today, timestamp) {
        if (streak.last_completed_date === today) {
            if (!streak.completed_today) {
                updateStreak.run(
                    streak.current_streak,
                    streak.last_completed_date,
                    1,
                    streak.warning_sent_date,
                    streak.loss_notified_date,
                    timestamp,
                    streak.guild_id,
                    streak.user_id
                );
            }
            return false;
        }

        if (streak.last_completed_date === previousDateKey(today)) {
            updateStreak.run(
                streak.current_streak,
                streak.last_completed_date,
                0,
                null,
                streak.loss_notified_date,
                timestamp,
                streak.guild_id,
                streak.user_id
            );
            return false;
        }

        const shouldNotifyLoss = streak.current_streak > 0 && streak.loss_notified_date !== previousDateKey(today);
        updateStreak.run(
            0,
            null,
            0,
            null,
            shouldNotifyLoss ? previousDateKey(today) : streak.loss_notified_date,
            timestamp,
            streak.guild_id,
            streak.user_id
        );
        return shouldNotifyLoss;
    }

    async function notifyLoss(guildId, userId) {
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) return;
        await user.send(LOSS_MESSAGE).catch((error) => {
            console.error(`[streak] Could not DM loss notice to ${userId} in ${guildId}:`, error);
        });
    }

    async function reconcileAll() {
        const timestamp = Date.now();
        const today = currentDateKey(timestamp);
        const lostUsers = [];

        for (const streak of getAllStreaks.all()) {
            if (!isActive(streak.guild_id)) continue;
            if (reconcileStreak(streak, today, timestamp)) {
                lostUsers.push({ guildId: streak.guild_id, userId: streak.user_id });
            }
        }

        const localParts = localDateParts(timestamp);
        if (Number(localParts.hour) >= REMINDER_HOUR) {
            for (const streak of getAllStreaks.all()) {
                if (streak.completed_today || streak.warning_sent_date === today) continue;
                updateStreak.run(
                    streak.current_streak,
                    streak.last_completed_date,
                    streak.completed_today,
                    today,
                    streak.loss_notified_date,
                    timestamp,
                    streak.guild_id,
                    streak.user_id
                );
                const user = await client.users.fetch(streak.user_id).catch(() => null);
                if (user) {
                    await user.send(REMINDER_MESSAGE).catch((error) => {
                        console.error(`[streak] Could not send reminder to ${streak.user_id}:`, error);
                    });
                }
            }
        }

        await Promise.all(lostUsers.map((user) => notifyLoss(user.guildId, user.userId)));
    }

    client.on(Events.MessageCreate, (message) => {
        if (message.author.bot || !message.guild || message.channel.id !== STREAK_CHANNEL_ID) return;
        if (!isValidMedia(message)) return;

        const timestamp = Date.now();
        const today = currentDateKey(timestamp);
        if (!isActive(message.guild.id)) return;
        const existing = getStreak.get(message.guild.id, message.author.id);
        if (!existing) insertStreak.run(message.guild.id, message.author.id, timestamp);

        const streak = getStreak.get(message.guild.id, message.author.id);
        const lost = reconcileStreak(streak, today, timestamp);
        const refreshed = getStreak.get(message.guild.id, message.author.id);
        if (refreshed.last_completed_date === today) {
            message.reply('انت رسلت مره عايز ترسل تاني ليه؟').catch((error) => {
                console.error(`[streak] Could not send confirmation to ${message.author.id}:`, error);
            });
            return;
        }

        const currentStreak = refreshed.current_streak + 1;
        updateStreak.run(
            currentStreak,
            today,
            1,
            null,
            null,
            timestamp,
            message.guild.id,
            message.author.id
        );

        message.reply(`🔥 مبروك! الستريك بتاعك: ${currentStreak}`).catch((error) => {
            console.error(`[streak] Could not send confirmation to ${message.author.id}:`, error);
        });

        if (lost) notifyLoss(message.guild.id, message.author.id).catch(() => {});
    });

    client.once(Events.ClientReady, () => {
        reconcileAll().catch((error) => console.error('[streak] Initial reconciliation failed:', error));
        const streakInterval = setInterval(() => {
            reconcileAll().catch((error) => console.error('[streak] Reconciliation failed:', error));
        }, CHECK_INTERVAL_MS);
        streakInterval.unref();
    });

    return {
        commandName: STREAK_COMMAND_NAME,
        handleCommand
    };
}

module.exports = {
    initializeDailyStreakSystem,
    STREAK_COMMAND_NAME
};