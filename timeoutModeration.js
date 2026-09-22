const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    Events,
    ModalBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;
const EVIDENCE_COLLECTION_MS = 120_000;
const STAFF_ROLE_ID = '1465092257211486372';
const ADMIN_ROLE_ID = '1473694686081192018';
const REVIEW_CHANNEL_ID = '1547812789676941382';
const REVISION_CHANNEL_ID = '1547820803339325481';
const TIMEOUT_REASONS = [
    '🚫 شتم',
    '⚠️ قذف',
    '😡 إهانة',
    '📢 إزعاج',
    '💬 سبام',
    '🔔 منشنات مزعجة',
    '👤 تنمر',
    '🔥 إثارة المشاكل',
    '📣 إعلان بدون إذن',
    '🔞 محتوى غير مناسب',
    '🔗 روابط مشبوهة',
    '⚔️ تهديد',
    '🎭 انتحال شخصية',
    '🔒 نشر معلومات شخصية',
    '🔁 تكرار المخالفات',
    '🛑 مخالفة قوانين السيرفر',
    '📝 سبب آخر'
];

function initializeTimeoutModeration(client, database, config = {}) {
    const staffRoleId = STAFF_ROLE_ID;
    const adminRoleId = ADMIN_ROLE_ID;
    const reviewChannelId = REVIEW_CHANNEL_ID;

    database.exec(`
        CREATE TABLE IF NOT EXISTS timeout_cases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            target_user_id TEXT NOT NULL,
            staff_user_id TEXT NOT NULL,
            duration_minutes INTEGER NOT NULL,
            original_reason TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            rejection_reason TEXT,
            revision_number TEXT,
            decision_admin_id TEXT,
            decision_at INTEGER,
            review_message_id TEXT,
            review_channel_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_timeout_cases_status ON timeout_cases(status);
        CREATE TABLE IF NOT EXISTS timeout_revision_sequence (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        );
    `);
    try {
        database.exec('ALTER TABLE timeout_cases ADD COLUMN revision_number TEXT');
    } catch (error) {
        if (!String(error.message).includes('duplicate column name')) throw error;
    }
    database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_timeout_cases_revision_number
            ON timeout_cases(revision_number) WHERE revision_number IS NOT NULL;
    `);
    database.prepare("UPDATE timeout_cases SET status = 'pending', updated_at = ? WHERE status = 'processing'").run(Date.now());

    const createCase = database.prepare(`
        INSERT INTO timeout_cases (
            guild_id, target_user_id, staff_user_id, duration_minutes,
            original_reason, evidence_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getCase = database.prepare('SELECT * FROM timeout_cases WHERE id = ?');
    const updateReviewMessage = database.prepare(
        'UPDATE timeout_cases SET review_message_id = ?, review_channel_id = ?, updated_at = ? WHERE id = ?'
    );
    const updateEvidence = database.prepare(
        "UPDATE timeout_cases SET evidence_json = ?, status = 'pending', updated_at = ? WHERE id = ?"
    );
    const updateApprovedDuration = database.prepare(
        'UPDATE timeout_cases SET duration_minutes = ?, updated_at = ? WHERE id = ? AND status = \'processing\''
    );

    const claimCase = database.transaction((caseId, nextStatus, adminId, rejectionReason = null) => {
        const revisionNumber = nextStatus === 'rejected'
            ? `REV-${String(database.prepare('INSERT INTO timeout_revision_sequence DEFAULT VALUES').run().lastInsertRowid).padStart(4, '0')}`
            : null;
        const result = database.prepare(`
            UPDATE timeout_cases
            SET status = ?, rejection_reason = ?, revision_number = ?, decision_admin_id = ?, decision_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'
        `).run(nextStatus, rejectionReason, revisionNumber, adminId, nextStatus === 'rejected' ? Date.now() : null, Date.now(), caseId);
        if (result.changes !== 1 && revisionNumber) {
            database.prepare('DELETE FROM timeout_revision_sequence WHERE id = ?').run(Number(revisionNumber.slice(4)));
        }
        return result.changes === 1;
    });

    const finishApproval = database.prepare(
        "UPDATE timeout_cases SET status = 'approved', decision_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'"
    );
    const releaseCase = database.prepare(
        "UPDATE timeout_cases SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'processing'"
    );

    function hasRole(member, roleId) {
        return Boolean(roleId && member?.roles?.cache?.has(roleId));
    }

    function isStaff(member) {
        return hasRole(member, staffRoleId);
    }

    function isAdmin(member) {
        return hasRole(member, adminRoleId);
    }

    function getConfiguredChannel(guild, channelId, channelName) {
        if (channelId) return guild.channels.fetch(channelId).catch(() => null);
        return Promise.resolve(guild.channels.cache.find(
            (channel) => channel.name === channelName && channel.isTextBased()
        ) || null);
    }

    function formatDuration(minutes) {
        if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} يوم`;
        if (minutes % 60 === 0) return `${minutes / 60} ساعة`;
        return `${minutes} دقيقة`;
    }

    function formatTime(timestamp) {
        return `<t:${Math.floor(timestamp / 1000)}:F>`;
    }

    async function handleTimeLookCommand(interaction) {
        if (!interaction.inGuild() || !isStaff(interaction.member)) {
            await interaction.reply({ content: '❌ هذا الأمر متاح لفريق STAFF فقط.', ephemeral: true });
            return;
        }

        const target = interaction.options.getUser('user', true);
        const timeoutCases = database.prepare(`
            SELECT * FROM timeout_cases
            WHERE guild_id = ? AND target_user_id = ?
            ORDER BY created_at DESC
        `).all(interaction.guild.id, target.id);
        if (timeoutCases.length === 0) {
            await interaction.reply({ content: `ℹ️ لا توجد حالات Timeout محفوظة للمستخدم <@${target.id}>.`, ephemeral: true });
            return;
        }

        const statusLabel = {
            approved: 'Approved',
            rejected: 'Rejected',
            pending: 'Pending',
            processing: 'Processing'
        };
        const reports = timeoutCases.map((timeoutCase) => {
            const evidenceFiles = evidenceFilesFromCase(timeoutCase);
            const evidenceNames = evidenceFiles.length > 0
                ? evidenceFiles.map((file) => `[${file.name}](attachment://${file.name})`).join('\n')
                : 'لا يوجد';
            const decisionLabel = timeoutCase.status === 'rejected' ? 'Rejected by' : 'Approved by';
            const decisionValue = timeoutCase.decision_admin_id
                ? `<@${timeoutCase.decision_admin_id}>\n${timeoutCase.decision_at ? formatTime(timeoutCase.decision_at) : ''}`
                : 'Not decided';
            const lines = [
                `**👤 User:** <@${timeoutCase.target_user_id}>`,
                `**📝 Timeout reason:** ${timeoutCase.original_reason}`,
                `**👮 Submitted by / STAFF:** <@${timeoutCase.staff_user_id}>`,
                `**⏱️ Timeout duration:** ${timeoutCase.status === 'approved' ? formatDuration(timeoutCase.duration_minutes) : 'Not applied'}`,
                `**👑 ${decisionLabel}:** ${decisionValue}`,
                `**📅 Date and time:** ${formatTime(timeoutCase.created_at)}`,
                `**📌 Status:** ${statusLabel[timeoutCase.status] || timeoutCase.status}`,
                `**📎 Evidence:** ${evidenceNames}`
            ];
            if (timeoutCase.status === 'rejected') {
                lines.push(`**❌ Rejection reason:** ${timeoutCase.rejection_reason || 'N/A'}`);
            }
            const embed = new EmbedBuilder()
                .setColor(timeoutCase.status === 'approved' ? 0x2ECC71 : timeoutCase.status === 'rejected' ? 0xC0392B : 0x3498DB)
                .setTitle(`⏱️ Timeout Case #${timeoutCase.id}`)
                .setDescription(lines.join('\n').slice(0, 4096))
                .setTimestamp(timeoutCase.created_at);
            const firstImage = evidenceFiles.find((file) => file.contentType?.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(file.name || ''));
            if (firstImage) embed.setImage(`attachment://${firstImage.name}`);
            return { embed, evidenceFiles };
        });

        for (let index = 0; index < reports.length; index += 10) {
            const batch = reports.slice(index, index + 10);
            await (index === 0 ? interaction.reply.bind(interaction) : interaction.followUp.bind(interaction))({
                embeds: batch.map((report) => report.embed),
                files: batch.flatMap((report) => report.evidenceFiles.map((file) => new AttachmentBuilder(file.buffer, { name: file.name }))),
                ephemeral: true
            });
        }
    }

    function evidenceText(evidence) {
        return evidence.length > 0 ? 'تم إرفاق الدليل أدناه.' : 'لا يوجد';
    }

    function safeEvidenceName(name, index, caseId) {
        const extension = (name || '').match(/\.[a-z0-9]{1,8}$/iu)?.[0] || '.bin';
        return `timeout-${caseId}-${index + 1}${extension.toLowerCase()}`;
    }

    async function downloadEvidence(attachments, caseId) {
        return Promise.all(attachments.map(async (attachment, index) => {
            const response = await fetch(attachment.url);
            if (!response.ok) throw new Error(`EVIDENCE_DOWNLOAD_FAILED_${response.status}`);
            return {
                name: safeEvidenceName(attachment.name, index, caseId),
                contentType: attachment.contentType || response.headers.get('content-type') || null,
                buffer: Buffer.from(await response.arrayBuffer())
            };
        }));
    }

    function evidenceFilesFromCase(timeoutCase) {
        return JSON.parse(timeoutCase.evidence_json)
            .filter((item) => item.data)
            .map((item) => ({
                name: item.name,
                contentType: item.contentType,
                buffer: Buffer.from(item.data, 'base64')
            }));
    }

    function isEvidenceAttachment(attachment) {
        if (attachment.contentType?.startsWith('image/') || attachment.contentType?.startsWith('video/')) {
            return true;
        }
        return /\.(?:png|jpe?g|gif|webp|bmp|mp4|mov|webm|mkv|avi)$/iu.test(attachment.name || '');
    }

    function reviewEmbed(timeoutCase, guild, evidence) {
        const embed = new EmbedBuilder()
            .setColor(0xE67E22)
            .setTitle(`⏱️ طلب Timeout #${timeoutCase.id}`)
            .setDescription('يرجى مراجعة الحالة واختيار الإجراء المناسب.')
            .addFields(
                { name: '👤 المستخدم المستهدف', value: `<@${timeoutCase.target_user_id}>`, inline: true },
                { name: '🛡️ الإداري الذي قام بالـTimeout', value: `<@${timeoutCase.staff_user_id}>`, inline: true },
                { name: '⏱️ مدة الـTimeout', value: 'يحددها ADMIN عند القبول', inline: true },
                { name: '📋 السبب الأصلي بالعربي', value: timeoutCase.original_reason.slice(0, 1024) },
                { name: '📎 الدليل', value: evidenceText(JSON.parse(timeoutCase.evidence_json)).slice(0, 1024) },
                { name: '🆔 رقم القضية', value: `#${timeoutCase.id}`, inline: true }
            )
            .setFooter({ text: guild.name })
            .setTimestamp(timeoutCase.created_at);
        const firstImage = evidence.find((item) => item.contentType?.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(item.name || ''));
        if (firstImage) embed.setImage(`attachment://${firstImage.name}`);
        return embed;
    }

    function reviewButtons(caseId, disabled = false) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`timeout:approve:${caseId}`).setLabel('قبول').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(disabled),
            new ButtonBuilder().setCustomId(`timeout:reject:${caseId}`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(disabled)
        );
    }

    async function sendRevision(timeoutCase, guild) {
        const channel = await getConfiguredChannel(guild, REVISION_CHANNEL_ID, '《🔰》revision');
        if (!channel || !channel.isTextBased()) {
            console.error(`[timeout] Revision channel is unavailable for case #${timeoutCase.id}.`);
            return;
        }

        const rejectionTime = timeoutCase.decision_at || Date.now();
        const embed = new EmbedBuilder()
            .setColor(0xC0392B)
            .setTitle(`❌ Revision Case ${timeoutCase.revision_number || `#${timeoutCase.id}`}`)
            .addFields(
                { name: '👤 المستخدم المستهدف', value: `<@${timeoutCase.target_user_id}>`, inline: true },
                { name: '🛡️ الإداري الذي قام بالـTimeout', value: `<@${timeoutCase.staff_user_id}>`, inline: true },
                { name: '⏱️ مدة الـTimeout', value: timeoutCase.duration_minutes > 0 ? formatDuration(timeoutCase.duration_minutes) : 'لم يتم تطبيق Timeout', inline: true },
                { name: '📋 السبب الأصلي بالعربي', value: timeoutCase.original_reason.slice(0, 1024) },
                { name: '📎 الدليل', value: evidenceText(JSON.parse(timeoutCase.evidence_json)).slice(0, 1024) },
                { name: '❌ سبب الرفض', value: (timeoutCase.rejection_reason || 'غير محدد').slice(0, 1024) },
                { name: '🔢 رقم القضية', value: timeoutCase.revision_number || `#${timeoutCase.id}`, inline: true },
                { name: '👑 الـADMIN الذي رفض الطلب', value: `<@${timeoutCase.decision_admin_id}>`, inline: true },
                { name: '🕐 وقت الرفض', value: formatTime(rejectionTime), inline: true },
                { name: '🆔 رقم القضية', value: `#${timeoutCase.id}`, inline: true }
            )
            .setFooter({ text: guild.name })
            .setTimestamp(rejectionTime);
        const evidenceFiles = evidenceFilesFromCase(timeoutCase);
        const firstImage = evidenceFiles.find((item) => item.contentType?.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(item.name || ''));
        if (firstImage) embed.setImage(`attachment://${firstImage.name}`);

        await channel.send({
            files: evidenceFiles.map((file) => new AttachmentBuilder(file.buffer, { name: file.name })),
            embeds: [embed]
        }).catch((error) => {
            console.error(`[timeout] Could not send Revision case #${timeoutCase.id}:`, error);
        });
    }

    async function sendReview(timeoutCase, guild, evidenceFiles) {
        const channel = await getConfiguredChannel(guild, reviewChannelId, '《🔰》timout');
        if (!channel || !channel.isTextBased()) throw new Error('TIMEOUT_REVIEW_CHANNEL_UNAVAILABLE');

        const message = await channel.send({
            files: evidenceFiles.map((file) => new AttachmentBuilder(file.buffer, { name: file.name })),
            embeds: [reviewEmbed(timeoutCase, guild, evidenceFiles)],
            components: [reviewButtons(timeoutCase.id)]
        });
        const storedEvidence = evidenceFiles.map((file) => ({
            name: file.name,
            contentType: file.contentType,
            data: file.buffer.toString('base64'),
            url: message.attachments.find((attachment) => attachment.name === file.name)?.url || null
        }));
        updateEvidence.run(JSON.stringify(storedEvidence), Date.now(), timeoutCase.id);
        updateReviewMessage.run(message.id, channel.id, Date.now(), timeoutCase.id);
    }

    async function disableReviewMessage(timeoutCase, guild) {
        if (!timeoutCase.review_channel_id || !timeoutCase.review_message_id) return;
        const channel = await guild.channels.fetch(timeoutCase.review_channel_id).catch(() => null);
        if (!channel?.isTextBased()) return;
        const message = await channel.messages.fetch(timeoutCase.review_message_id).catch(() => null);
        if (message) await message.edit({ components: [reviewButtons(timeoutCase.id, true)] });
    }

    async function canTimeout(member, guild) {
        const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
        if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) return false;
        if (!member || member.id === guild.ownerId || member.id === botMember.id) return false;
        return member.manageable && botMember.roles.highest.comparePositionTo(member.roles.highest) > 0;
    }

    async function handleTimeoutCommand(interaction) {
        if (!interaction.inGuild() || !isStaff(interaction.member)) {
            await interaction.reply({ content: '❌ هذا الأمر متاح لفريق STAFF فقط.', ephemeral: true });
            return;
        }

        const target = interaction.options.getMember('user');
        const reason = interaction.options.getString('reason', true).trim();
        if (!target || target.user.bot) {
            await interaction.reply({ content: '❌ لا يمكنني تطبيق Timeout على هذا المستخدم بسبب الصلاحيات أو ترتيب الرتب.', ephemeral: true });
            return;
        }

        const timestamp = Date.now();
        const caseId = createCase.run(
            interaction.guild.id,
            target.id,
            interaction.user.id,
            0,
            reason,
            '[]',
            timestamp,
            timestamp
        ).lastInsertRowid;

        await interaction.reply({
            content: `📎 أرسل الآن صورة أو فيديو للدليل في هذه القناة خلال دقيقتين. رقم القضية: #${caseId}`,
            ephemeral: true
        });

        const collector = interaction.channel.createMessageCollector({
            filter: (message) => message.author.id === interaction.user.id && [...message.attachments.values()].some(isEvidenceAttachment),
            max: 1,
            time: EVIDENCE_COLLECTION_MS
        });
        collector.on('collect', async (message) => {
            try {
                const timeoutCase = getCase.get(caseId);
                const evidenceFiles = await downloadEvidence(
                    [...message.attachments.values()].filter(isEvidenceAttachment),
                    caseId
                );
                await sendReview(timeoutCase, interaction.guild, evidenceFiles);
                await message.delete().catch((error) => {
                    console.error(`[timeout] Could not remove evidence message for case #${caseId}:`, error);
                });
                await interaction.channel.send('✅ تم رفع الدليل بنجاح.').catch((error) => {
                    console.error(`[timeout] Could not confirm evidence for case #${caseId}:`, error);
                });
                await interaction.editReply({ content: `✅ تم حفظ القضية #${caseId} وإرسالها للمراجعة. لم يتم تطبيق Timeout.` });
            } catch (error) {
                console.error(`[timeout] Could not complete case #${caseId}:`, error);
                await interaction.editReply({ content: '❌ تعذر إرسال القضية للمراجعة. لم يتم تطبيق Timeout.' });
            }
        });
        collector.on('end', async (collected) => {
            if (collected.size === 0) {
                await interaction.editReply({ content: `⌛ انتهت مهلة الدليل للقضية #${caseId}. لم يتم تطبيق Timeout.` }).catch(() => {});
            }
        });
    }

    async function handleApprove(interaction, caseId) {
        if (!isAdmin(interaction.member)) {
            await interaction.reply({ content: '❌ لا تملك صلاحية مراجعة هذه الحالة.', ephemeral: true });
            return;
        }
        const timeoutCase = getCase.get(caseId);
        if (!timeoutCase || timeoutCase.status !== 'pending') {
            await interaction.reply({ content: '⚠️ تمت معالجة هذه القضية مسبقًا أو لم تعد متاحة.', ephemeral: true });
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId(`timeout:approve-modal:${caseId}`)
            .setTitle(`قبول القضية #${caseId}`);
        const durationInput = new TextInputBuilder()
            .setCustomId('approved-duration')
            .setLabel('المدة بالدقائق (حتى 28 يومًا)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('مثال: 60')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(5);
        modal.addComponents(new ActionRowBuilder().addComponents(durationInput));
        await interaction.showModal(modal);
    }

    async function handleApproveModal(interaction, caseId) {
        if (!isAdmin(interaction.member)) {
            await interaction.reply({ content: '❌ لا تملك صلاحية مراجعة هذه الحالة.', ephemeral: true });
            return;
        }

        const duration = Number(interaction.fields.getTextInputValue('approved-duration').trim());
        if (!Number.isInteger(duration) || duration < 1 || duration > MAX_TIMEOUT_MINUTES) {
            await interaction.reply({ content: `❌ أدخل مدة صحيحة من 1 إلى ${MAX_TIMEOUT_MINUTES} دقيقة.`, ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        const timeoutCase = getCase.get(caseId);
        if (!timeoutCase || timeoutCase.status !== 'pending' || !claimCase(caseId, 'processing', interaction.user.id)) {
            await interaction.editReply({ content: '⚠️ تمت معالجة هذه القضية مسبقًا أو لم تعد متاحة.' });
            return;
        }

        const member = await interaction.guild.members.fetch(timeoutCase.target_user_id).catch(() => null);
        if (!(await canTimeout(member, interaction.guild))) {
            releaseCase.run(Date.now(), caseId);
            await interaction.editReply({ content: '❌ لا يمكنني تطبيق Timeout بسبب المستخدم المفقود أو الصلاحيات أو ترتيب الرتب.' });
            return;
        }

        try {
            await member.timeout(duration * 60_000, timeoutCase.original_reason);
            updateApprovedDuration.run(duration, Date.now(), caseId);
            finishApproval.run(Date.now(), Date.now(), caseId);
            await disableReviewMessage(timeoutCase, interaction.guild);
            await interaction.editReply({ content: `✅ تم قبول القضية وتطبيق Timeout لمدة ${formatDuration(duration)}.` });
        } catch (error) {
            releaseCase.run(Date.now(), caseId);
            console.error(`[timeout] Approval failed for case #${caseId}:`, error);
            await interaction.editReply({ content: '❌ فشل تطبيق Timeout. بقيت القضية متاحة للمراجعة.' });
        }
    }

    async function handleRejectButton(interaction, caseId) {
        if (!isAdmin(interaction.member)) {
            await interaction.reply({ content: '❌ لا تملك صلاحية مراجعة هذه الحالة.', ephemeral: true });
            return;
        }
        const timeoutCase = getCase.get(caseId);
        if (!timeoutCase || timeoutCase.status !== 'pending') {
            await interaction.reply({ content: '⚠️ تمت معالجة هذه القضية مسبقًا أو لم تعد متاحة.', ephemeral: true });
            return;
        }
        const modal = new ModalBuilder().setCustomId(`timeout:reject-modal:${caseId}`).setTitle(`رفض القضية #${caseId}`);
        const reasonInput = new TextInputBuilder()
            .setCustomId('rejection-reason')
            .setLabel('سبب الرفض')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000);
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
    }

    async function handleRejectModal(interaction, caseId) {
        if (!isAdmin(interaction.member)) {
            await interaction.reply({ content: '❌ لا تملك صلاحية مراجعة هذه الحالة.', ephemeral: true });
            return;
        }
        const rejectionReason = interaction.fields.getTextInputValue('rejection-reason').trim();
        if (!rejectionReason) {
            await interaction.reply({ content: '❌ يجب كتابة سبب واضح للرفض.', ephemeral: true });
            return;
        }
        if (!claimCase(caseId, 'rejected', interaction.user.id, rejectionReason)) {
            await interaction.reply({ content: '⚠️ تمت معالجة هذه القضية مسبقًا.', ephemeral: true });
            return;
        }
        const timeoutCase = getCase.get(caseId);
        await interaction.update({ components: [reviewButtons(caseId, true)] });
        await sendRevision(timeoutCase, interaction.guild);
    }

    client.on(Events.InteractionCreate, (interaction) => {
        if (interaction.isChatInputCommand() && interaction.commandName === 'timelook') {
            handleTimeLookCommand(interaction).catch((error) => console.error('[timeout] Time look command failed:', error));
            return;
        }
        if (interaction.isChatInputCommand() && interaction.commandName === 'timeout') {
            handleTimeoutCommand(interaction).catch((error) => console.error('[timeout] Command failed:', error));
            return;
        }
        if (interaction.isButton()) {
            const match = interaction.customId.match(/^timeout:(approve|reject):(\d+)$/u);
            if (!match) return;
            if (match[1] === 'approve') handleApprove(interaction, Number(match[2])).catch((error) => console.error('[timeout] Approval failed:', error));
            else handleRejectButton(interaction, Number(match[2])).catch((error) => console.error('[timeout] Rejection button failed:', error));
            return;
        }
        if (interaction.isModalSubmit()) {
            const approveMatch = interaction.customId.match(/^timeout:approve-modal:(\d+)$/u);
            if (approveMatch) {
                handleApproveModal(interaction, Number(approveMatch[1])).catch((error) => console.error('[timeout] Approval form failed:', error));
                return;
            }
            const match = interaction.customId.match(/^timeout:reject-modal:(\d+)$/u);
            if (match) handleRejectModal(interaction, Number(match[1])).catch((error) => console.error('[timeout] Rejection failed:', error));
        }
    });

    client.once(Events.ClientReady, async () => {
        async function upsertCommand(guild, command) {
            const existing = (await guild.commands.fetch()).find((item) => item.name === command.name);
            if (existing) return existing.edit(command);
            return guild.commands.create(command);
        }
        const command = new SlashCommandBuilder()
            .setName('timeout')
            .setDescription('تقديم طلب Timeout مع دليل للمراجعة')
            .addUserOption((option) => option.setName('user').setDescription('المستخدم المستهدف').setRequired(true))
            .addStringOption((option) => {
                option.setName('reason').setDescription('اختر السبب الأصلي بالعربي').setRequired(true);
                for (const reason of TIMEOUT_REASONS) {
                    option.addChoices({ name: reason, value: reason });
                }
                return option;
            });
        const timeLookCommand = new SlashCommandBuilder()
            .setName('timelook')
            .setDescription('عرض سجل Timeout لمستخدم')
            .addUserOption((option) => option.setName('user').setDescription('المستخدم المطلوب').setRequired(true));
        for (const guild of client.guilds.cache.values()) {
            await upsertCommand(guild, command).catch((error) => console.error(`[timeout] Could not register /timeout in ${guild.id}:`, error));
            await upsertCommand(guild, timeLookCommand).catch((error) => console.error(`[timeout] Could not register /timelook in ${guild.id}:`, error));
        }
    });
}

module.exports = { initializeTimeoutModeration };