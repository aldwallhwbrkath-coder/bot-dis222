const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    Events,
    PermissionFlagsBits,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalBuilder,
    ChannelType
} = require('discord.js');

const STAFF_ROLE_ID = '1465092257211486372';
const ADMIN_ROLE_ID = '1473694686081192018';
const MODERATOR_ROLE_ID = '1353487185420095559';
const HEAD_ADMIN_ROLE_ID = '1383898372099801148';
const SERVER_MANAGER_ROLE_ID = '1087819191572242512';
const PANEL_CHANNEL_ID = '1020071195418300487';
const CLAIM_CHANNEL_ID = '1547828299189723146';
const LOG_CHANNEL_ID = '1082799886057078794';
const TICKET_PANEL_CUSTOM_ID = 'ticket:open';
const TICKET_NUMBER_WIDTH = 3;

function initializeTicketSystem(client, database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS ticket_sequence (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        );
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_number INTEGER NOT NULL UNIQUE,
            guild_id TEXT NOT NULL,
            channel_id TEXT UNIQUE,
            creator_id TEXT NOT NULL,
            staff_id TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            created_at INTEGER NOT NULL,
            claimed_at INTEGER,
            closed_at INTEGER,
            claim_message_id TEXT,
            evaluation_message_id TEXT,
            transcript_message_id TEXT
        );
        CREATE TABLE IF NOT EXISTS ticket_messages (
            message_id TEXT PRIMARY KEY,
            ticket_id INTEGER NOT NULL,
            author_id TEXT NOT NULL,
            author_tag TEXT NOT NULL,
            content TEXT NOT NULL,
            attachments_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ticket_evaluations (
            ticket_id INTEGER PRIMARY KEY,
            creator_id TEXT NOT NULL,
            staff_id TEXT,
            solved INTEGER NOT NULL,
            rating INTEGER,
            comment TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS ticket_panels (
            channel_id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ticket_highstuff_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id INTEGER NOT NULL,
            requester_id TEXT NOT NULL,
            requested_role_id TEXT,
            reason TEXT,
            created_at INTEGER NOT NULL,
            message_id TEXT,
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_highstuff_active
            ON ticket_highstuff_requests(ticket_id) WHERE active = 1;
    `);
    try {
        database.exec('ALTER TABLE ticket_highstuff_requests ADD COLUMN requested_role_id TEXT');
    } catch (error) {
        if (!String(error.message).includes('duplicate column name')) throw error;
    }

    const getTicketByChannel = database.prepare('SELECT * FROM tickets WHERE channel_id = ?');
    const getTicket = database.prepare('SELECT * FROM tickets WHERE id = ?');
    const getOpenTicket = database.prepare(`
        SELECT * FROM tickets
        WHERE guild_id = ? AND creator_id = ? AND status IN ('open', 'claimed', 'closed', 'evaluating')
        LIMIT 1
    `);
    const updateTicketClaimMessage = database.prepare(
        'UPDATE tickets SET claim_message_id = ? WHERE id = ?'
    );
    const clearTicketClaimMessage = database.prepare(
        'UPDATE tickets SET claim_message_id = NULL WHERE id = ?'
    );
    const updateEvaluationMessage = database.prepare(
        'UPDATE tickets SET evaluation_message_id = ? WHERE id = ?'
    );
    const insertMessage = database.prepare(`
        INSERT INTO ticket_messages (
            message_id, ticket_id, author_id, author_tag, content, attachments_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO NOTHING
    `);
    const insertEvaluation = database.prepare(`
        INSERT INTO ticket_evaluations (ticket_id, creator_id, staff_id, solved, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ticket_id) DO NOTHING
    `);
    const getEvaluation = database.prepare('SELECT * FROM ticket_evaluations WHERE ticket_id = ?');
    const getHighstuffRequest = database.prepare(
        'SELECT * FROM ticket_highstuff_requests WHERE ticket_id = ? AND active = 1'
    );
    const createHighstuffRequest = database.prepare(`
        INSERT INTO ticket_highstuff_requests (ticket_id, requester_id, requested_role_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
    `);
    const saveHighstuffMessage = database.prepare(
        'UPDATE ticket_highstuff_requests SET message_id = ? WHERE id = ?'
    );
    const completeHighstuffRequest = database.prepare(
        'UPDATE ticket_highstuff_requests SET active = 0 WHERE id = ? AND active = 1'
    );

    function hasRole(member, roleId) {
        return Boolean(member?.roles?.cache?.has(roleId));
    }

    function isStaff(member) {
        return hasRole(member, STAFF_ROLE_ID);
    }

    function isAdmin(member) {
        return hasRole(member, ADMIN_ROLE_ID);
    }

    function isServerManager(member) {
        return hasRole(member, SERVER_MANAGER_ROLE_ID);
    }

    const highstuffRoles = new Map([
        [MODERATOR_ROLE_ID, '𝗠𝗼𝗱𝗲𝗿𝗮𝘁𝗼𝗿 𝗱𝗶𝘀𝗰𝗼𝗿𝗱'],
        [ADMIN_ROLE_ID, 'ADMIN'],
        [HEAD_ADMIN_ROLE_ID, '𝑯𝒆𝒂𝒅 𝒂𝒅𝒎𝒊𝒏']
    ]);

    function ticketName(number) {
        return `ticket-${String(number).padStart(TICKET_NUMBER_WIDTH, '0')}`;
    }

    function mentionOrId(userId) {
        return userId ? `<@${userId}>` : 'غير متوفر';
    }

    function timestamp(value) {
        return `<t:${Math.floor(value / 1000)}:F>`;
    }

    function getChannel(guild, channelId, fallbackName) {
        if (channelId) return guild.channels.fetch(channelId).catch(() => null);
        return Promise.resolve(guild.channels.cache.find((channel) => channel.name === fallbackName));
    }

    function claimButton(ticketId, disabled = false) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`ticket:claim:${ticketId}`)
                .setLabel('استلام Ticket')
                .setEmoji('🛡️')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(disabled)
        );
    }

    function panelEmbed() {
        return new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🎟️ التحدث مع الإدارة')
            .setDescription(
                'إذا كنت تريد التحدث مع الإدارة، افتح Ticket.'
            )
            .addFields(
                {
                    name: '💬 لا تفتح Ticket بدون سبب.',
                    value: 'اكتب سببك بشكل واضح ومختصر.'
                },
                {
                    name: '🛡️ تحدث مع الإدارة بأسلوب محترم وجيد.',
                    value: 'استخدم اللغة المناسبة واحترم جميع أعضاء الإدارة.'
                },
                {
                    name: '📌 استخدم الـ Ticket للاستفسارات أو المشاكل المتعلقة بالإدارة.',
                    value: '\u200b'
                },
                {
                    name: '🚫 لا تفتح Tickets بشكل عشوائي أو مكرر بدون سبب.',
                    value: '\u200b'
                },
                {
                    name: '⏱️ أهم شيء الالتزام بالأسلوب الجيد والاحترام.',
                    value: '\u200b'
                }
            )
            .setFooter({ text: 'نحن هنا لمساعدتك' });
    }

    function panelButton() {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(TICKET_PANEL_CUSTOM_ID)
                .setLabel('فتح Ticket')
                .setEmoji('🎟️')
                .setStyle(ButtonStyle.Primary)
        );
    }

    function claimEmbed(ticket) {
        return new EmbedBuilder()
            .setColor(ticket.status === 'claimed' ? 0x2ECC71 : 0xF1C40F)
            .setTitle(`🎟️ ${ticketName(ticket.ticket_number)}`)
            .addFields(
                { name: '🔢 رقم Ticket', value: `#${ticket.ticket_number}`, inline: true },
                { name: '👤 صاحب Ticket', value: mentionOrId(ticket.creator_id), inline: true },
                { name: '📅 وقت الإنشاء', value: timestamp(ticket.created_at), inline: true },
                { name: '📌 الحالة', value: ticket.status === 'claimed' ? 'تم الاستلام' : 'بانتظار STAFF', inline: true },
                { name: '🛡️ الإداري المستلم', value: mentionOrId(ticket.staff_id), inline: true }
            );
    }

    function evaluationButtons(ticketId, disabled = false) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ticket:solved:yes:${ticketId}`).setLabel('نعم').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(disabled),
            new ButtonBuilder().setCustomId(`ticket:solved:no:${ticketId}`).setLabel('لا').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(disabled)
        );
    }

    function ratingMenu(ticketId) {
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`ticket:rating:${ticketId}`)
            .setPlaceholder('اختر تقييم الإداري من 1 إلى 10')
            .addOptions(Array.from({ length: 10 }, (_, index) => ({
                label: `${index + 1} / 10`,
                value: String(index + 1),
                description: `التقييم ${index + 1} من 10`
            })));
        return new ActionRowBuilder().addComponents(menu);
    }

    async function applyTicketPermissions(channel, guild, creatorId, staffId = null, locked = false) {
        await channel.permissionOverwrites.edit(creatorId, {
            ViewChannel: true,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true,
            SendMessages: !locked
        });
        await channel.permissionOverwrites.edit(STAFF_ROLE_ID, staffId
            ? { ViewChannel: false, SendMessages: false, ReadMessageHistory: false }
            : { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        await channel.permissionOverwrites.edit(ADMIN_ROLE_ID, {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: !locked
        });
        if (guild.members.me) {
            await channel.permissionOverwrites.edit(guild.members.me.id, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                ManageChannels: true,
                ManageMessages: true
            });
        }
        if (staffId) {
            await channel.permissionOverwrites.edit(staffId, {
                ViewChannel: true,
                ReadMessageHistory: true,
                AttachFiles: true,
                EmbedLinks: true,
                SendMessages: !locked
            });
        }
    }

    async function recordTicketMessage(message) {
        if (!message.guild) return;
        const ticket = getTicketByChannel.get(message.channel.id);
        if (!ticket) return;
        const attachments = [...message.attachments.values()].map((attachment) => ({
            name: attachment.name || 'attachment',
            url: attachment.url,
            contentType: attachment.contentType || null
        }));
        insertMessage.run(
            message.id,
            ticket.id,
            message.author.id,
            message.author.tag,
            message.content || '',
            JSON.stringify(attachments),
            message.createdTimestamp || Date.now()
        );
    }

    async function captureChannelHistory(channel, ticket) {
        let before;
        while (true) {
            const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
            if (!batch || batch.size === 0) break;
            for (const message of batch.values()) await recordTicketMessage(message);
            if (batch.size < 100) break;
            before = batch.last().id;
        }
        return database.prepare(`
            SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC
        `).all(ticket.id);
    }

    function transcriptText(ticket, evaluation, messages) {
        const lines = [
            `Ticket: ${ticketName(ticket.ticket_number)} (#${ticket.ticket_number})`,
            `Creator: ${ticket.creator_id}`,
            `STAFF: ${ticket.staff_id || 'unclaimed'}`,
            `Created: ${new Date(ticket.created_at).toISOString()}`,
            `Claimed: ${ticket.claimed_at ? new Date(ticket.claimed_at).toISOString() : 'N/A'}`,
            `Closed: ${ticket.closed_at ? new Date(ticket.closed_at).toISOString() : 'N/A'}`,
            `Solved: ${evaluation ? (evaluation.solved ? 'Yes' : 'No') : 'N/A'}`,
            `Rating: ${evaluation?.rating || 'N/A'}/10`,
            `Comment: ${evaluation?.comment || 'N/A'}`,
            '',
            '--- Conversation ---'
        ];
        for (const message of messages) {
            const attachments = JSON.parse(message.attachments_json).map((item) => item.url).join(', ');
            lines.push(`[${new Date(message.created_at).toISOString()}] ${message.author_tag} (${message.author_id}): ${message.content || '[no text]'}${attachments ? ` | Attachments: ${attachments}` : ''}`);
        }
        return lines.join('\n');
    }

    async function finalizeTicket(ticketId, guild) {
        const ticket = getTicket.get(ticketId);
        const evaluation = getEvaluation.get(ticketId);
        if (!ticket || !evaluation || ticket.status === 'completed') return;
        const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
        const messages = channel ? await captureChannelHistory(channel, ticket) : database.prepare(
            'SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC'
        ).all(ticket.id);
        const logChannel = await getChannel(guild, LOG_CHANNEL_ID, 'logs-ticket');
        if (!logChannel || !logChannel.isTextBased()) {
            throw new Error('TICKET_LOG_CHANNEL_UNAVAILABLE');
        }

        const transcript = transcriptText(ticket, evaluation, messages);
        const logEmbed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle(`📚 Transcript ${ticketName(ticket.ticket_number)}`)
            .addFields(
                { name: '👤 صاحب Ticket', value: mentionOrId(ticket.creator_id), inline: true },
                { name: '🛡️ STAFF', value: mentionOrId(ticket.staff_id), inline: true },
                { name: '📅 الإنشاء', value: timestamp(ticket.created_at), inline: true },
                { name: '📥 الاستلام', value: ticket.claimed_at ? timestamp(ticket.claimed_at) : 'غير مستلم', inline: true },
                { name: '🔒 الإغلاق', value: ticket.closed_at ? timestamp(ticket.closed_at) : 'غير متوفر', inline: true },
                { name: '✅ تم الحل؟', value: evaluation.solved ? 'نعم' : 'لا', inline: true },
                { name: '⭐ التقييم', value: `${evaluation.rating}/10`, inline: true },
                { name: '💬 الملاحظة', value: (evaluation.comment || 'لا توجد ملاحظة').slice(0, 1024) }
            );
        const sentLog = await logChannel.send({
            embeds: [logEmbed],
            files: [{ attachment: Buffer.from(transcript, 'utf8'), name: `${ticketName(ticket.ticket_number)}-transcript.txt` }]
        });
        database.prepare(`
            UPDATE tickets SET status = 'completed', transcript_message_id = ? WHERE id = ? AND status = 'evaluating'
        `).run(sentLog.id, ticketId);
        if (channel) await channel.delete(`Ticket ${ticketName(ticket.ticket_number)} archived after evaluation`).catch(() => {});
    }

    async function handlePanelCommand(interaction) {
        if (!isServerManager(interaction.member)) {
            await interaction.reply({ content: '❌ لا تملك صلاحية نشر لوحة التذاكر. هذا الأمر متاح لدور Server Manager فقط.', ephemeral: true });
            return;
        }
        const panelChannel = await getChannel(interaction.guild, PANEL_CHANNEL_ID, '🎟️・𝙏𝙞𝙘𝙠𝙚𝙩');
        if (!panelChannel || !panelChannel.isTextBased()) {
            await interaction.reply({ content: '❌ قناة لوحة التذاكر غير موجودة أو لا أملك صلاحية الوصول إليها.', ephemeral: true });
            return;
        }
        const existing = database.prepare('SELECT * FROM ticket_panels WHERE channel_id = ?').get(PANEL_CHANNEL_ID);
        if (existing) {
            const message = await panelChannel.messages.fetch(existing.message_id).catch(() => null);
            if (message) {
                await message.edit({ embeds: [panelEmbed()], components: [panelButton()] });
                await interaction.reply({ content: '✅ تم تحديث لوحة التذاكر.', ephemeral: true });
                return;
            }
            database.prepare('DELETE FROM ticket_panels WHERE channel_id = ?').run(PANEL_CHANNEL_ID);
        }
        const panel = await panelChannel.send({ embeds: [panelEmbed()], components: [panelButton()] });
        database.prepare(
            'INSERT INTO ticket_panels (channel_id, message_id, created_at) VALUES (?, ?, ?)'
        ).run(PANEL_CHANNEL_ID, panel.id, Date.now());
        await interaction.reply({ content: '✅ تم نشر لوحة التذاكر.', ephemeral: true });
    }

    async function handleOpenTicket(interaction) {
        const existing = getOpenTicket.get(interaction.guild.id, interaction.user.id);
        if (existing) {
            const channel = await interaction.guild.channels.fetch(existing.channel_id).catch(() => null);
            if (channel) {
                await interaction.reply({ content: `⚠️ لديك Ticket مفتوح بالفعل: ${channel}`, ephemeral: true });
                return;
            }
            database.prepare("UPDATE tickets SET status = 'completed' WHERE id = ?").run(existing.id);
        }
        const number = database.transaction(() => database.prepare('INSERT INTO ticket_sequence DEFAULT VALUES').run().lastInsertRowid)();
        const permissionOverwrites = [
            { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
            { id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: ADMIN_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
        ];
        if (interaction.guild.members.me) {
            permissionOverwrites.push({
                id: interaction.guild.members.me.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels]
            });
        }
        const channel = await interaction.guild.channels.create({
            name: ticketName(number),
            type: ChannelType.GuildText,
            topic: `Ticket #${number} | ${interaction.user.id}`,
            permissionOverwrites
        });
        const createdAt = Date.now();
        const ticketId = database.prepare(`
            INSERT INTO tickets (ticket_number, guild_id, channel_id, creator_id, status, created_at)
            VALUES (?, ?, ?, ?, 'open', ?)
        `).run(number, interaction.guild.id, channel.id, interaction.user.id, createdAt).lastInsertRowid;
        const ticket = getTicket.get(ticketId);
        await channel.send({
            embeds: [new EmbedBuilder().setColor(0x3498DB).setTitle('🎟️ تم فتح التذكرة بنجاح.').setDescription('⏳ يرجى الانتظار حتى يقوم أحد أفراد الإدارة باستلام التذكرة.').addFields({ name: '🔢 رقم Ticket', value: `#${number}` })]
        });
        const claimChannel = await getChannel(interaction.guild, CLAIM_CHANNEL_ID, '《🔰》استلا-التكيتات');
        if (claimChannel && claimChannel.isTextBased()) {
            const claimMessage = await claimChannel.send({ embeds: [claimEmbed(ticket)], components: [claimButton(ticketId)] });
            updateTicketClaimMessage.run(claimMessage.id, ticketId);
        }
        await interaction.reply({ content: `✅ تم إنشاء Ticket الخاص بك: ${channel}`, ephemeral: true });
    }

    async function handleClaim(interaction, ticketId) {
        if (!isStaff(interaction.member)) {
            await interaction.reply({ content: '❌ استلام التذاكر متاح لـ STAFF فقط.', ephemeral: true });
            return;
        }
        const result = database.prepare(`
            UPDATE tickets SET staff_id = ?, status = 'claimed', claimed_at = ?
            WHERE id = ? AND status = 'open' AND staff_id IS NULL
        `).run(interaction.user.id, Date.now(), ticketId);
        if (result.changes !== 1) {
            await interaction.reply({ content: '⚠️ تم استلام هذا Ticket مسبقًا.', ephemeral: true });
            return;
        }
        await interaction.deferReply({ ephemeral: true });
        const ticket = getTicket.get(ticketId);
        const channel = await interaction.guild.channels.fetch(ticket.channel_id).catch(() => null);
        if (!channel) {
            database.prepare("UPDATE tickets SET staff_id = NULL, status = 'open', claimed_at = NULL WHERE id = ?").run(ticketId);
            await interaction.editReply({ content: '❌ قناة Ticket غير موجودة، تمت إعادة الحالة للانتظار.' });
            return;
        }
        try {
            await applyTicketPermissions(channel, interaction.guild, ticket.creator_id, interaction.user.id);
        } catch (error) {
            database.prepare("UPDATE tickets SET staff_id = NULL, status = 'open', claimed_at = NULL WHERE id = ?").run(ticketId);
            await interaction.editReply({ content: '❌ تعذر منح صلاحيات الوصول إلى Ticket بسبب نقص الصلاحيات.' }).catch(() => {});
            return;
        }
        await interaction.message.delete().catch((error) => {
            console.error(`[ticket] Could not delete claim message for #${ticketId}:`, error);
        });
        clearTicketClaimMessage.run(ticketId);
        await channel.send(`🛡️ تم استلام Ticket بواسطة <@${interaction.user.id}>.`).catch((error) => {
            console.error(`[ticket] Could not announce claim for #${ticketId}:`, error);
        });
        await interaction.editReply({ content: `✅ تم استلام ${ticketName(ticket.ticket_number)} وأصبح ظاهرًا لك.` });
    }

    async function handleClose(interaction) {
        const ticket = getTicketByChannel.get(interaction.channel.id);
        if (!ticket || !isStaff(interaction.member) || ticket.staff_id !== interaction.user.id) {
            await interaction.reply({ content: '❌ هذا الأمر متاح للـSTAFF المستلم لهذا Ticket فقط.', ephemeral: true });
            return;
        }
        const result = database.prepare(`
            UPDATE tickets SET status = 'evaluating', closed_at = ? WHERE id = ? AND status = 'claimed' AND staff_id = ?
        `).run(Date.now(), ticket.id, interaction.user.id);
        if (result.changes !== 1) {
            await interaction.reply({ content: '⚠️ هذا Ticket مغلق أو قيد التقييم بالفعل.', ephemeral: true });
            return;
        }
        const updated = getTicket.get(ticket.id);
        await applyTicketPermissions(interaction.channel, interaction.guild, updated.creator_id, updated.staff_id, true);
        const evaluationMessage = await interaction.channel.send({
            embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('📝 تقييم Ticket').setDescription('هل تم حل مشكلتك؟')],
            components: [evaluationButtons(ticket.id)]
        });
        updateEvaluationMessage.run(evaluationMessage.id, ticket.id);
        await interaction.reply({ content: '🔒 تم إغلاق Ticket وإرسال التقييم للعضو.', ephemeral: true });
    }

    async function handleAdd(interaction) {
        if (!isStaff(interaction.member)) {
            await interaction.reply({ content: '❌ هذا الأمر متاح لفريق STAFF فقط.', ephemeral: true });
            return;
        }
        const ticket = getTicketByChannel.get(interaction.channelId);
        if (!ticket || ticket.status !== 'claimed' || ticket.staff_id !== interaction.user.id) {
            await interaction.reply({ content: '❌ يجب استخدام هذا الأمر داخل Ticket مستلم منك.', ephemeral: true });
            return;
        }
        const target = interaction.options.getMember('user');
        if (!target || target.user.bot) {
            await interaction.reply({ content: '❌ اختر مستخدمًا صالحًا لإضافته إلى هذا Ticket.', ephemeral: true });
            return;
        }
        const channel = interaction.channel;
        const permissions = channel.permissionsFor(target);
        if (permissions?.has(PermissionFlagsBits.ViewChannel)) {
            await interaction.reply({ content: 'ℹ️ هذا المستخدم لديه وصول بالفعل إلى هذا Ticket.', ephemeral: true });
            return;
        }
        await channel.permissionOverwrites.edit(target.id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
        });
        await interaction.reply({ content: `✅ تمت إضافة <@${target.id}> إلى هذا Ticket فقط.`, ephemeral: true });
    }

    async function handleHighstuff(interaction) {
        if (!isStaff(interaction.member)) {
            await interaction.reply({ content: '❌ هذا الأمر متاح لفريق STAFF فقط.', ephemeral: true });
            return;
        }
        const ticket = getTicketByChannel.get(interaction.channelId);
        if (!ticket || ticket.status !== 'claimed' || ticket.staff_id !== interaction.user.id) {
            await interaction.reply({ content: '❌ يجب استخدام هذا الأمر داخل Ticket مستلم منك.', ephemeral: true });
            return;
        }
        if (getHighstuffRequest.get(ticket.id)) {
            await interaction.reply({ content: '⚠️ تم إرسال طلب High Staff لهذا Ticket بالفعل.', ephemeral: true });
            return;
        }

        const requestedRoleId = interaction.options.getString('role', true);
        const requestedRoleName = highstuffRoles.get(requestedRoleId);
        if (!requestedRoleName) {
            await interaction.reply({ content: '❌ الرتبة المطلوبة غير مسموحة.', ephemeral: true });
            return;
        }
        const reason = interaction.options.getString('reason')?.trim() || null;
        let requestId;
        try {
            requestId = createHighstuffRequest.run(ticket.id, interaction.user.id, requestedRoleId, reason, Date.now()).lastInsertRowid;
        } catch (error) {
            if (String(error.message).includes('UNIQUE constraint failed')) {
                await interaction.reply({ content: '⚠️ تم إرسال طلب High Staff لهذا Ticket بالفعل.', ephemeral: true });
                return;
            }
            throw error;
        }
        const claimChannel = await getChannel(interaction.guild, CLAIM_CHANNEL_ID, '《🔰》استلا-التكيتات');
        if (!claimChannel || !claimChannel.isTextBased()) {
            database.prepare('DELETE FROM ticket_highstuff_requests WHERE id = ?').run(requestId);
            await interaction.reply({ content: '❌ لم أجد قناة إدارة التذاكر لإرسال الطلب.', ephemeral: true });
            return;
        }

        const ticketChannel = await interaction.guild.channels.fetch(ticket.channel_id).catch(() => null);
        const ticketLink = ticketChannel
            ? `https://discord.com/channels/${interaction.guild.id}/${ticket.channel_id}`
            : 'القناة غير متاحة حاليًا';
        let notification;
        try {
            notification = await claimChannel.send({
                content: `<@&${requestedRoleId}>`,
                embeds: [new EmbedBuilder()
                    .setColor(0xE74C3C)
                    .setTitle('🚨 High Staff Request')
                    .addFields(
                        { name: '🎟️ Ticket', value: `${ticketName(ticket.ticket_number)} (#${ticket.ticket_number})`, inline: true },
                        { name: '👤 صاحب Ticket', value: mentionOrId(ticket.creator_id), inline: true },
                        { name: '🛡️ STAFF الطالب', value: mentionOrId(interaction.user.id), inline: true },
                        { name: '🎯 الرتبة المطلوبة', value: `<@&${requestedRoleId}> (${requestedRoleName})`, inline: true },
                        { name: '💬 السبب', value: (reason || 'لم يتم تحديد سبب').slice(0, 1024) },
                        { name: '🕐 وقت الطلب', value: timestamp(Date.now()), inline: true }
                    )],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`ticket:highclaim:${requestId}`).setLabel('استلام Ticket').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setLabel('فتح Ticket').setStyle(ButtonStyle.Link).setURL(ticketLink)
                )]
            });
        } catch (error) {
            database.prepare('DELETE FROM ticket_highstuff_requests WHERE id = ?').run(requestId);
            throw error;
        }
        saveHighstuffMessage.run(notification.id, requestId);
        await interaction.reply({ content: '✅ تم إرسال طلب المساعدة إلى Senior Administration مع إبقاء Ticket مفتوحًا.', ephemeral: true });
    }

    async function handleHighstuffClaim(interaction, requestId) {
        const request = database.prepare(
            'SELECT * FROM ticket_highstuff_requests WHERE id = ? AND active = 1'
        ).get(requestId);
        if (!request || !hasRole(interaction.member, request.requested_role_id)) {
            await interaction.reply({ content: '❌ ليس لديك الرتبة المطلوبة لاستلام هذه التذكرة.', ephemeral: true });
            return;
        }
        const ticket = getTicket.get(request.ticket_id);
        if (!ticket || !['claimed', 'open'].includes(ticket.status)) {
            await interaction.reply({ content: '⚠️ لم تعد هذه التذكرة متاحة للاستلام.', ephemeral: true });
            return;
        }
        const previousStaffId = ticket.staff_id;
        const previousStatus = ticket.status;
        const result = database.prepare(`
            UPDATE tickets SET staff_id = ?, status = 'claimed', claimed_at = COALESCE(claimed_at, ?)
            WHERE id = ?
        `).run(interaction.user.id, Date.now(), ticket.id);
        if (result.changes !== 1) {
            await interaction.reply({ content: '⚠️ تعذر تعيين مستلم هذه التذكرة.', ephemeral: true });
            return;
        }
        const channel = await interaction.guild.channels.fetch(ticket.channel_id).catch(() => null);
        if (!channel) {
            database.prepare('UPDATE tickets SET staff_id = ?, status = ? WHERE id = ?').run(previousStaffId, previousStatus, ticket.id);
            await interaction.reply({ content: '❌ قناة Ticket غير موجودة.', ephemeral: true });
            return;
        }
        try {
            await applyTicketPermissions(channel, interaction.guild, ticket.creator_id, interaction.user.id);
            completeHighstuffRequest.run(request.id);
            await interaction.message.delete().catch(() => {});
            await channel.send(`🛡️ تم استلام Ticket بواسطة <@${interaction.user.id}>.`).catch(() => {});
            await interaction.reply({ content: `✅ تم استلام ${ticketName(ticket.ticket_number)} وأصبح ظاهرًا لك.`, ephemeral: true });
        } catch (error) {
            database.prepare('UPDATE tickets SET staff_id = ?, status = ? WHERE id = ?').run(previousStaffId, previousStatus, ticket.id);
            await interaction.reply({ content: '❌ تعذر منح صلاحيات الوصول إلى Ticket بسبب نقص الصلاحيات.', ephemeral: true });
        }
    }

    async function handleSolved(interaction, ticketId, solved) {
        const ticket = getTicket.get(ticketId);
        if (!ticket || ticket.status !== 'evaluating' || interaction.user.id !== ticket.creator_id) {
            await interaction.reply({ content: '❌ لا يمكنك إرسال تقييم هذا Ticket.', ephemeral: true });
            return;
        }
        const existingEvaluation = getEvaluation.get(ticketId);
        if (existingEvaluation) {
            await interaction.reply({ content: '⚠️ تم تسجيل إجابتك مسبقًا.', ephemeral: true });
            return;
        }
        insertEvaluation.run(ticket.id, ticket.creator_id, ticket.staff_id, solved ? 1 : 0, Date.now());
        await interaction.update({ components: [evaluationButtons(ticket.id, true)] });
        await interaction.channel.send({ content: '⭐ قيم الإداري من 10:', components: [ratingMenu(ticket.id)] });
    }

    async function handleRating(interaction, ticketId) {
        const ticket = getTicket.get(ticketId);
        if (!ticket || ticket.status !== 'evaluating' || interaction.user.id !== ticket.creator_id) {
            await interaction.reply({ content: '❌ لا يمكنك إرسال تقييم هذا Ticket.', ephemeral: true });
            return;
        }
        const rating = Number(interaction.values[0]);
        if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
            await interaction.reply({ content: '❌ التقييم يجب أن يكون من 1 إلى 10.', ephemeral: true });
            return;
        }
        const existingEvaluation = getEvaluation.get(ticketId);
        if (!existingEvaluation || existingEvaluation.rating !== null) {
            await interaction.reply({ content: '⚠️ تم تسجيل التقييم مسبقًا أو لم تبدأ مرحلة التقييم.', ephemeral: true });
            return;
        }
        database.prepare('UPDATE ticket_evaluations SET rating = ? WHERE ticket_id = ?').run(rating, ticketId);
        const modal = new ModalBuilder().setCustomId(`ticket:comment:${ticketId}`).setTitle('ملاحظة اختيارية');
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('comment').setLabel('هل لديك أي ملاحظة؟').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
        ));
        await interaction.showModal(modal);
    }

    async function handleComment(interaction, ticketId) {
        const ticket = getTicket.get(ticketId);
        if (!ticket || ticket.status !== 'evaluating' || interaction.user.id !== ticket.creator_id) {
            await interaction.reply({ content: '❌ لا يمكنك إرسال تقييم هذا Ticket.', ephemeral: true });
            return;
        }
        const existingEvaluation = getEvaluation.get(ticketId);
        if (!existingEvaluation || existingEvaluation.rating === null || existingEvaluation.completed_at) {
            await interaction.reply({ content: '⚠️ تم إنهاء التقييم مسبقًا أو لم يكتمل ترتيب الخطوات.', ephemeral: true });
            return;
        }
        const comment = interaction.fields.getTextInputValue('comment').trim();
        database.prepare('UPDATE ticket_evaluations SET comment = ?, completed_at = ? WHERE ticket_id = ?').run(comment, Date.now(), ticketId);
        await interaction.reply({ content: '✅ شكرًا لك، تم حفظ التقييم.', ephemeral: true });
        await finalizeTicket(ticketId, interaction.guild).catch((error) => console.error(`[ticket] Could not finalize #${ticketId}:`, error));
    }

    async function handleRatingsCommand(message) {
        if (!message.guild || !isStaff(message.member)) return;
        const stats = database.prepare(`
            SELECT COUNT(*) AS total,
                   COUNT(e.rating) AS rated,
                   AVG(e.rating) AS average,
                   SUM(CASE WHEN e.solved = 1 THEN 1 ELSE 0 END) AS solved,
                   SUM(CASE WHEN e.solved = 0 THEN 1 ELSE 0 END) AS unsolved
            FROM tickets t LEFT JOIN ticket_evaluations e ON e.ticket_id = t.id
            WHERE t.guild_id = ? AND t.staff_id = ? AND t.status = 'completed'
        `).get(message.guild.id, message.author.id);
        const feedback = database.prepare(`
            SELECT e.rating, e.solved, e.comment, t.ticket_number, e.completed_at
            FROM ticket_evaluations e JOIN tickets t ON t.id = e.ticket_id
            WHERE t.guild_id = ? AND t.staff_id = ? AND e.comment IS NOT NULL AND e.comment != ''
            ORDER BY e.completed_at DESC LIMIT 10
        `).all(message.guild.id, message.author.id);
        const feedbackText = feedback.length
            ? feedback.map((item) => `#${item.ticket_number} | ${item.rating}/10 | ${item.solved ? 'تم الحل' : 'لم يُحل'}\n${item.comment}`).join('\n\n').slice(0, 1024)
            : 'لا توجد ملاحظات بعد.';
        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle(`📊 تقييمات ${message.member.displayName}`)
            .addFields(
                { name: '🎟️ إجمالي Tickets', value: String(stats.total || 0), inline: true },
                { name: '⭐ التقييمات المستلمة', value: String(stats.rated || 0), inline: true },
                { name: '📈 المتوسط من 10', value: stats.average ? Number(stats.average).toFixed(2) : 'لا يوجد', inline: true },
                { name: '✅ تم حلها', value: String(stats.solved || 0), inline: true },
                { name: '❌ لم تُحل', value: String(stats.unsolved || 0), inline: true },
                { name: '💬 الملاحظات السابقة', value: feedbackText }
            );
        await message.reply({ embeds: [embed] });
    }

    client.on(Events.MessageCreate, (message) => {
        recordTicketMessage(message).catch((error) => console.error('[ticket] Could not record message:', error));
        if (message.author.bot) return;
        if (message.content.trim() === '!تقييماتي') {
            handleRatingsCommand(message).catch((error) => console.error('[ticket] Ratings command failed:', error));
        }
    });

    client.on(Events.InteractionCreate, (interaction) => {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'ticket' && interaction.options.getSubcommand() === 'here') {
                handlePanelCommand(interaction).catch((error) => console.error('[ticket] Panel command failed:', error));
            } else if (interaction.commandName === 'close') {
                handleClose(interaction).catch((error) => console.error('[ticket] Close command failed:', error));
            } else if (interaction.commandName === 'add') {
                handleAdd(interaction).catch((error) => console.error('[ticket] Add command failed:', error));
            } else if (interaction.commandName === 'highstuff') {
                handleHighstuff(interaction).catch((error) => console.error('[ticket] High staff command failed:', error));
            }
            return;
        }
        if (interaction.isButton()) {
            if (interaction.customId === TICKET_PANEL_CUSTOM_ID) {
                handleOpenTicket(interaction).catch((error) => console.error('[ticket] Open failed:', error));
                return;
            }
            let match = interaction.customId.match(/^ticket:claim:(\d+)$/u);
            if (match) {
                handleClaim(interaction, Number(match[1])).catch((error) => console.error('[ticket] Claim failed:', error));
                return;
            }
            match = interaction.customId.match(/^ticket:highclaim:(\d+)$/u);
            if (match) {
                handleHighstuffClaim(interaction, Number(match[1])).catch((error) => console.error('[ticket] High staff claim failed:', error));
                return;
            }
            match = interaction.customId.match(/^ticket:solved:(yes|no):(\d+)$/u);
            if (match) {
                handleSolved(interaction, Number(match[2]), match[1] === 'yes').catch((error) => console.error('[ticket] Solved choice failed:', error));
            }
            return;
        }
        if (interaction.isStringSelectMenu()) {
            const match = interaction.customId.match(/^ticket:rating:(\d+)$/u);
            if (match) handleRating(interaction, Number(match[1])).catch((error) => console.error('[ticket] Rating failed:', error));
            return;
        }
        if (interaction.isModalSubmit()) {
            const match = interaction.customId.match(/^ticket:comment:(\d+)$/u);
            if (match) handleComment(interaction, Number(match[1])).catch((error) => console.error('[ticket] Comment failed:', error));
        }
    });

    client.once(Events.ClientReady, async () => {
        const ticketCommand = new SlashCommandBuilder()
            .setName('ticket')
            .setDescription('إدارة نظام التذاكر')
            .addSubcommand((subcommand) => subcommand.setName('here').setDescription('نشر لوحة التذاكر'));
        const closeCommand = new SlashCommandBuilder()
            .setName('close')
            .setDescription('إغلاق Ticket الحالي وإرسال التقييم');
        const addCommand = new SlashCommandBuilder()
            .setName('add')
            .setDescription('إضافة مستخدم إلى Ticket الحالي')
            .addUserOption((option) => option.setName('user').setDescription('المستخدم المراد إضافته').setRequired(true));
        const highstuffCommand = new SlashCommandBuilder()
            .setName('highstuff')
            .setDescription('طلب مساعدة Senior Administration')
            .addStringOption((option) => option.setName('role').setDescription('الرتبة التي تريد استدعاءها').setRequired(true)
                .addChoices(...[...highstuffRoles].map(([value, name]) => ({ name, value }))))
            .addStringOption((option) => option.setName('reason').setDescription('سبب طلب المساعدة').setRequired(false).setMaxLength(1000));
        async function upsertCommand(guild, command) {
            const existing = (await guild.commands.fetch()).find((item) => item.name === command.name);
            if (existing) return existing.edit(command);
            return guild.commands.create(command);
        }
        for (const guild of client.guilds.cache.values()) {
            await upsertCommand(guild, ticketCommand).catch((error) => console.error(`[ticket] Could not register /ticket in ${guild.id}:`, error));
            await upsertCommand(guild, closeCommand).catch((error) => console.error(`[ticket] Could not register /close in ${guild.id}:`, error));
            await upsertCommand(guild, addCommand).catch((error) => console.error(`[ticket] Could not register /add in ${guild.id}:`, error));
            await upsertCommand(guild, highstuffCommand).catch((error) => console.error(`[ticket] Could not register /highstuff in ${guild.id}:`, error));
        }
    });
}

module.exports = { initializeTicketSystem };
