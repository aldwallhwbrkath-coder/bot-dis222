const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    Events,
    ModalBuilder,
    PermissionFlagsBits,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder
} = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');

const CREATOR_CHANNEL_ID = '1478810942983897159';
const TEMPVOICE_CATEGORY_ID = '1478810941910028499';
const LEGACY_COMMAND_NAME = 'voicenow';
const MAX_LIMIT = 99;
const OWNER_ERROR = '❌ You are not the owner of this Voice Channel.';

function initializeVoiceRoomSystem(client, database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS temporary_voice_rooms (
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL UNIQUE,
            text_channel_id TEXT,
            panel_message_id TEXT,
            owner_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            current_members TEXT NOT NULL DEFAULT '[]',
            join_history TEXT NOT NULL DEFAULT '[]',
            trusted_users TEXT NOT NULL DEFAULT '[]',
            blocked_users TEXT NOT NULL DEFAULT '[]',
            privacy INTEGER NOT NULL DEFAULT 1,
            user_limit INTEGER NOT NULL DEFAULT 0,
            waiting_room INTEGER NOT NULL DEFAULT 0,
            chat_enabled INTEGER NOT NULL DEFAULT 1,
            region TEXT,
            PRIMARY KEY (guild_id, channel_id)
        );
    `);

    for (const [column, definition] of [
        ['current_members', "TEXT NOT NULL DEFAULT '[]'"],
        ['join_history', "TEXT NOT NULL DEFAULT '[]'"],
        ['text_channel_id', 'TEXT'],
        ['panel_message_id', 'TEXT']
    ]) {
        try {
            database.exec(`ALTER TABLE temporary_voice_rooms ADD COLUMN ${column} ${definition}`);
        } catch (error) {
            if (!String(error.message).includes('duplicate column name')) throw error;
        }
    }

    const getRoom = database.prepare('SELECT * FROM temporary_voice_rooms WHERE guild_id = ? AND channel_id = ?');
    const getRooms = database.prepare('SELECT * FROM temporary_voice_rooms WHERE guild_id = ?');
    const getOwnerRoom = database.prepare('SELECT * FROM temporary_voice_rooms WHERE guild_id = ? AND owner_id = ?');
    const insertRoom = database.prepare(`INSERT INTO temporary_voice_rooms
        (guild_id, channel_id, text_channel_id, panel_message_id, owner_id, created_at, current_members, join_history)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const updateRoom = database.prepare(`UPDATE temporary_voice_rooms SET owner_id = ?, current_members = ?, join_history = ?,
        trusted_users = ?, blocked_users = ?, privacy = ?, user_limit = ?, waiting_room = ?, chat_enabled = ?, region = ?, text_channel_id = ?, panel_message_id = ?
        WHERE guild_id = ? AND channel_id = ?`);
    const deleteRoom = database.prepare('DELETE FROM temporary_voice_rooms WHERE guild_id = ? AND channel_id = ?');
    const locks = new Map();
    const creating = new Set();

    function list(value) { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }

    function stateOf(room) {
        return {
            owner: room.owner_id,
            members: list(room.current_members),
            history: list(room.join_history),
            trusted: list(room.trusted_users),
            blocked: list(room.blocked_users),
            privacy: Boolean(room.privacy),
            limit: room.user_limit,
            waiting: Boolean(room.waiting_room),
            chat: Boolean(room.chat_enabled),
            region: room.region || null,
            textChannelId: room.text_channel_id || null,
            panelMessageId: room.panel_message_id || null
        };
    }

    function saveRoom(room, changes = {}) {
        const current = stateOf(room);
        const next = { ...current, ...changes };
        updateRoom.run(
            next.owner,
            JSON.stringify(next.members),
            JSON.stringify(next.history),
            JSON.stringify(next.trusted),
            JSON.stringify(next.blocked),
            Number(next.privacy),
            Number(next.limit),
            Number(next.waiting),
            Number(next.chat),
            next.region,
            next.textChannelId || null,
            next.panelMessageId || null,
            room.guild_id,
            room.channel_id
        );
        return getRoom.get(room.guild_id, room.channel_id);
    }

    function locked(key, task) {
        const previous = locks.get(key) || Promise.resolve();
        const current = previous.catch(() => {}).then(task);
        locks.set(key, current.finally(() => {
            if (locks.get(key) === current) locks.delete(key);
        }));
        return current;
    }

    function button(id, label, style = ButtonStyle.Secondary) {
        return new ButtonBuilder().setCustomId(`voice:${id}`).setLabel(label).setStyle(style);
    }

    function panelImage() {
        const canvas = createCanvas(1200, 620);
        const context = canvas.getContext('2d');
        context.fillStyle = '#17191f';
        context.fillRect(0, 0, 1200, 620);
        context.fillStyle = '#252936';
        context.fillRect(32, 32, 1136, 556);
        context.fillStyle = '#5865f2';
        context.fillRect(32, 32, 12, 556);
        context.fillStyle = '#ffffff';
        context.font = 'bold 42px sans-serif';
        context.fillText('Voice Control Panel', 78, 105);
        context.fillStyle = '#aeb4c0';
        context.font = '24px sans-serif';
        context.fillText('Manage your temporary voice channel', 80, 145);
        const labels = ['RENAME', 'KICK', 'OPEN', 'LOCK', 'INCREASE LIMIT', 'DECREASE LIMIT', 'USER LIMIT', 'TRUST', 'UNTRUST', 'BLOCK', 'UNBLOCK', 'TRANSFER', 'DELETE ROOM'];
        labels.forEach((label, index) => {
            const x = 80 + (index % 4) * 270;
            const y = 205 + Math.floor(index / 4) * 105;
            context.fillStyle = index === 11 ? '#ed4245' : '#313541';
            context.fillRect(x, y, 235, 62);
            context.fillStyle = '#ffffff';
            context.font = 'bold 18px sans-serif';
            context.fillText(label, x + 16, y + 38);
        });
        return canvas.toBuffer('image/png');
    }

    function panelPayload() {
        const controls = [
            ['name', '✏️ Rename'], ['kick', '👤 Kick'], ['open-room', '🔓 فتح'], ['lock-room', '🔒 قفل'], ['increase-limit', '🔊 Increase Limit'],
            ['decrease-limit', '🔉 Decrease Limit'], ['limit', '👥 User Limit'], ['trust', '🟢 Trust'], ['untrust', '🔴 Untrust'], ['block', '🚫 Block'],
            ['unblock', '🔓 Unblock'], ['transfer', '🔄 Transfer Ownership'], ['delete', '🗑️ Delete Room']
        ];
        return {
            files: [new AttachmentBuilder(panelImage(), { name: 'voice-control-panel.png' })],
            embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎙️ Voice Control Panel').setDescription('Use the buttons below to manage this temporary voice channel.')],
            components: Array.from({ length: 3 }, (_, row) => new ActionRowBuilder().addComponents(controls.slice(row * 5, row * 5 + 5).map(([id, label]) => button(id, label, id === 'delete' || id === 'lock-room' ? ButtonStyle.Danger : id === 'open-room' ? ButtonStyle.Success : ButtonStyle.Secondary))))
        };
    }

    async function requireOwner(interaction, channelId = null) {
        const targetChannelId = channelId || interaction.member?.voice?.channelId || null;
        const guildRooms = getRooms.all(interaction.guild.id);
        const room = targetChannelId ? getRoom.get(interaction.guild.id, targetChannelId) : null;
        const textRoom = !room && interaction.channel && interaction.channel.type === ChannelType.GuildText
            ? guildRooms.find((candidate) => candidate.text_channel_id === interaction.channel.id)
            : null;
        const resolvedRoom = room || textRoom;
        if (!resolvedRoom) {
            if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: OWNER_ERROR, ephemeral: true });
            return null;
        }

        const isInVoice = interaction.member?.voice?.channelId === resolvedRoom.channel_id;
        const isInControlChannel = interaction.channelId === resolvedRoom.channel_id;
        const isOwner = resolvedRoom.owner_id === interaction.user.id;

        if (!isOwner || (!isInVoice && !isInControlChannel)) {
            if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: OWNER_ERROR, ephemeral: true });
            return null;
        }

        return resolvedRoom;
    }

    async function applyPermissions(room, channel) {
        const state = stateOf(room);
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
            ViewChannel: !state.privacy,
            Connect: !state.privacy && !state.waiting,
            SendMessages: false
        });
        await channel.permissionOverwrites.edit(room.owner_id, { ViewChannel: true, Connect: true, SendMessages: true, ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true });
        for (const userId of state.trusted) {
            if (!state.blocked.includes(userId)) {
                await channel.permissionOverwrites.edit(userId, { ViewChannel: true, Connect: true, SendMessages: state.chat });
            }
        }
        for (const userId of state.blocked) {
            await channel.permissionOverwrites.edit(userId, { ViewChannel: false, Connect: false, SendMessages: false });
        }
        if (client.user) {
            await channel.permissionOverwrites.edit(client.user.id, { ViewChannel: true, Connect: true, SendMessages: true, ManageChannels: true, MoveMembers: true });
        }
    }

    async function applyTextPermissions(room, channel) {
        if (!channel || channel.type !== ChannelType.GuildText) return;
        const state = stateOf(room);
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
            ViewChannel: !state.privacy,
            SendMessages: false,
            ReadMessageHistory: !state.privacy
        });
        await channel.permissionOverwrites.edit(room.owner_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, ManageChannels: true });
        for (const userId of [...state.trusted, ...state.members]) {
            if (!state.blocked.includes(userId)) {
                await channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: state.chat, ReadMessageHistory: true });
            }
        }
        for (const userId of state.blocked) {
            await channel.permissionOverwrites.edit(userId, { ViewChannel: false, SendMessages: false, ReadMessageHistory: false });
        }
        await channel.permissionOverwrites.edit(client.user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, ManageChannels: true });
    }

    async function removeRoomNow(guildId, channelId, reason) {
        const room = getRoom.get(guildId, channelId);
        if (!room) return;
        deleteRoom.run(guildId, channelId);

        if (room.text_channel_id && room.text_channel_id !== channelId) {
            const legacyTextChannel = await client.channels.fetch(room.text_channel_id).catch(() => null);
            if (legacyTextChannel && legacyTextChannel.type === ChannelType.GuildText) {
                await legacyTextChannel.delete(reason).catch((error) => console.error('[voice-room] Legacy text channel delete failed:', error));
            }
        }

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel && channelId !== CREATOR_CHANNEL_ID && channel.type !== ChannelType.GuildCategory) {
            await channel.delete(reason).catch((error) => console.error('[voice-room] Voice delete failed:', error));
        }
    }

    async function removeRoom(guildId, channelId, reason = 'Temporary voice channel cleanup') {
        return locked(`${guildId}:${channelId}`, () => removeRoomNow(guildId, channelId, reason));
    }

    async function ensurePanel(room, channel) {
        if (room.text_channel_id === channel.id && room.panel_message_id) return room;

        const legacyTextChannel = room.text_channel_id && room.text_channel_id !== channel.id
            ? await client.channels.fetch(room.text_channel_id).catch(() => null)
            : null;
        const panelMessage = await channel.send(panelPayload());
        if (legacyTextChannel && legacyTextChannel.type === ChannelType.GuildText) {
            await legacyTextChannel.delete('Migrated voice control panel into voice channel text chat').catch(() => {});
        }
        return saveRoom(room, { textChannelId: channel.id, panelMessageId: panelMessage.id });
    }

    async function createRoom(member) {
        const key = `${member.guild.id}:${member.id}`;
        if (creating.has(key)) return;
        creating.add(key);
        try {
            const existing = getOwnerRoom.get(member.guild.id, member.id);
            if (existing) {
                const existingChannel = await member.guild.channels.fetch(existing.channel_id).catch(() => null);
                if (existingChannel) return member.voice.setChannel(existingChannel).catch(() => {});
                deleteRoom.run(member.guild.id, existing.channel_id);
            }

            const creator = await member.guild.channels.fetch(CREATOR_CHANNEL_ID).catch(() => null);
            const category = await member.guild.channels.fetch(TEMPVOICE_CATEGORY_ID).catch(() => null);
            if (!creator || creator.type !== ChannelType.GuildVoice || !category || category.type !== ChannelType.GuildCategory) {
                console.error('[voice-room] Creator channel or TEMPVOICE category is missing or invalid.');
                return;
            }

            const roomChannel = await member.guild.channels.create({
                name: `${member.displayName}'s Room`.slice(0, 100),
                type: ChannelType.GuildVoice,
                parent: TEMPVOICE_CATEGORY_ID,
                permissionOverwrites: [
                    { id: member.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages] },
                    { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] }
                ]
            });

            const now = Date.now();
            insertRoom.run(
                member.guild.id,
                roomChannel.id,
                roomChannel.id,
                null,
                member.id,
                now,
                JSON.stringify([member.id]),
                JSON.stringify([{ userId: member.id, joinedAt: now, sequence: 1 }])
            );

            const room = getRoom.get(member.guild.id, roomChannel.id);
            const panelMessage = await roomChannel.send(panelPayload());
            const updatedRoom = saveRoom(room, { panelMessageId: panelMessage.id, textChannelId: roomChannel.id });
            await applyPermissions(updatedRoom, roomChannel);
            await member.voice.setChannel(roomChannel).catch(() => removeRoom(member.guild.id, roomChannel.id, 'Member could not be moved into temporary channel'));
        } catch (error) {
            console.error('[voice-room] Creation failed:', error);
        } finally {
            creating.delete(key);
        }
    }

    function targetMenu(action, room) {
        return new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`voice:target:${action}:${room.channel_id}`).setPlaceholder('Select a member').setMinValues(1).setMaxValues(1));
    }

    function previousOwner(history, members, ownerId) {
        const ownerEntry = history.find((entry) => entry.userId === ownerId);
        if (!ownerEntry) return members[0];
        return history
            .filter((entry) => members.includes(entry.userId) && Number(entry.sequence) < Number(ownerEntry.sequence))
            .sort((a, b) => Number(b.sequence) - Number(a.sequence))[0]?.userId || members[0];
    }

    async function openModal(interaction, room, type) {
        const modal = new ModalBuilder()
            .setCustomId(`voice:modal:${type}:${room.channel_id}`)
            .setTitle(type === 'name' ? 'Rename voice channel' : 'Change user limit');

        const input = new TextInputBuilder()
            .setCustomId('value')
            .setLabel(type === 'name' ? 'Channel name' : 'User limit (0-99)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(type === 'name' ? 100 : 2);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    }

    async function handleButton(interaction) {
        const action = interaction.customId.slice('voice:'.length);
        const room = await requireOwner(interaction);
        if (!room) return;
        const channel = await interaction.guild.channels.fetch(room.channel_id).catch(() => null);
        if (!channel) return removeRoom(room.guild_id, room.channel_id);

        if (['name', 'limit'].includes(action)) return openModal(interaction, room, action);
        if (['trust', 'untrust', 'kick', 'block', 'unblock', 'transfer'].includes(action)) {
            return interaction.reply({ content: 'Select a member for this action:', components: [targetMenu(action, room)], ephemeral: true });
        }
        if (action === 'delete') {
            return interaction.reply({
                content: 'Delete this temporary voice channel?',
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`voice:delete-confirm:${room.channel_id}`).setLabel('DELETE').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId('voice:delete-cancel').setLabel('CANCEL').setStyle(ButtonStyle.Secondary)
                    )
                ],
                ephemeral: true
            });
        }
        if (action === 'region') {
            const regions = ['automatic', 'us-east', 'us-central', 'us-west', 'brazil', 'singapore', 'rotterdam', 'hongkong', 'japan', 'southafrica', 'sydney', 'europe'];
            return interaction.reply({
                content: 'Choose a region:',
                components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`voice:region:${room.channel_id}`).setPlaceholder('Select region').addOptions(regions.map((value) => ({ label: value, value }))))],
                ephemeral: true
            });
        }

        await interaction.deferReply({ ephemeral: true });
        const state = stateOf(room);
        const changes = {};
        if (action === 'open-room') changes.privacy = false;
        if (action === 'lock-room') changes.privacy = true;
        if (action === 'increase-limit') changes.limit = Math.min(MAX_LIMIT, state.limit + 1 || 1);
        if (action === 'decrease-limit') changes.limit = Math.max(0, state.limit - 1);

        const updated = saveRoom(room, changes);
        await applyPermissions(updated, channel);
        if (action === 'open-room') return interaction.editReply('✅ تم فتح الروم للجميع.');
        if (action === 'lock-room') return interaction.editReply('🔒 تم قفل الروم.');
        return interaction.editReply(`✅ ${action} updated.`);
    }

    async function handleTarget(interaction) {
        const [, , action, channelId] = interaction.customId.split(':');
        const room = await requireOwner(interaction, channelId);
        if (!room) return;
        await interaction.deferUpdate();
        const targetId = interaction.values[0];
        const target = await interaction.guild.members.fetch(targetId).catch(() => null);
        if (!target || target.user.bot || target.id === room.owner_id) {
            return interaction.editReply({ content: '❌ Invalid target member.', components: [] });
        }

        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel) return removeRoom(room.guild_id, room.channel_id);

        const state = stateOf(room);
        const trusted = state.trusted.filter((id) => id !== targetId);
        const blocked = state.blocked.filter((id) => id !== targetId);

        if (action === 'trust') trusted.push(targetId);
        if (action === 'block') blocked.push(targetId);
        if (action === 'untrust') { /* handled by removing from trusted */ }
        if (action === 'unblock') { /* handled by removing from blocked */ }
        if (action === 'transfer') {
            if (target.voice.channelId !== channelId) {
                return interaction.editReply({ content: '❌ The new owner must be in this Voice Channel.', components: [] });
            }
            state.owner = targetId;
        }
        if (['kick', 'block'].includes(action) && target.voice.channelId === channelId) {
            await target.voice.disconnect().catch(() => {});
        }

        const updated = saveRoom(room, { owner: state.owner, trusted, blocked });
        await applyPermissions(updated, channel);
        return interaction.editReply({ content: `✅ ${action} completed for <@${targetId}>.`, components: [] });
    }

    async function handleModal(interaction) {
        const [, , type, channelId] = interaction.customId.split(':');
        const room = await requireOwner(interaction, channelId);
        if (!room) return;
        await interaction.deferReply({ ephemeral: true });
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel) return removeRoom(room.guild_id, room.channel_id);

        const value = interaction.fields.getTextInputValue('value').trim();
        if (type === 'name') {
            await channel.setName(value.slice(0, 100));
            return interaction.editReply('✅ Voice Channel renamed.');
        }

        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
            return interaction.editReply('❌ Limit must be between 0 and 99.');
        }
        await channel.setUserLimit(limit);
        saveRoom(room, { limit });
        return interaction.editReply('✅ Voice Channel updated.');
    }

    async function reconcileRoom(guild, room) {
        const channel = await guild.channels.fetch(room.channel_id).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildVoice) return removeRoom(room.guild_id, room.channel_id);

        const state = stateOf(room);
        const members = [...channel.members.values()].filter((member) => !member.user.bot).map((member) => member.id);
        if (!members.length) return removeRoom(room.guild_id, room.channel_id, 'Temporary voice channel was empty after restart');

        const history = state.history.slice();
        let sequence = history.reduce((max, entry) => Math.max(max, Number(entry.sequence) || 0), 0);
        for (const userId of members) {
            if (!history.some((entry) => entry.userId === userId)) {
                history.push({ userId, joinedAt: Date.now(), sequence: ++sequence });
            }
        }

        const owner = members.includes(room.owner_id) ? room.owner_id : previousOwner(history, members, room.owner_id);

        if (!owner) return removeRoom(room.guild_id, room.channel_id);

        const updated = saveRoom(room, { owner, members, history });
        await applyPermissions(updated, channel).catch((error) => console.error('[voice-room] Reconciliation failed:', error));
        await ensurePanel(updated, channel).catch((error) => console.error('[voice-room] Panel reconciliation failed:', error));
    }

    async function removeLegacyCommand() {
        for (const guild of client.guilds.cache.values()) {
            const commands = await guild.commands.fetch();
            const legacy = commands.find((command) => command.name === LEGACY_COMMAND_NAME);
            if (legacy) await legacy.delete();
        }
    }

    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        const guild = newState.guild || oldState.guild;
        if (!guild) return;
        if (newState.channelId === CREATOR_CHANNEL_ID && oldState.channelId !== CREATOR_CHANNEL_ID && newState.member && !newState.member.user.bot) createRoom(newState.member);

        const ids = [oldState.channelId, newState.channelId].filter((id, index, values) => id && id !== CREATOR_CHANNEL_ID && values.indexOf(id) === index);
        for (const channelId of ids) {
            locked(`${guild.id}:${channelId}`, async () => {
                const room = getRoom.get(guild.id, channelId);
                if (!room) return;
                const channel = await guild.channels.fetch(channelId).catch(() => null);
                if (!channel) return removeRoomNow(guild.id, channelId, 'Temporary voice channel was deleted');

                const state = stateOf(room);
                const memberId = newState.id || oldState.id;
                const joining = newState.channelId === channelId && oldState.channelId !== channelId;
                const members = state.members.filter((id) => channel.members.has(id));
                let nextMembers = members;
                let history = state.history;

                if (joining && !nextMembers.includes(memberId) && !newState.member?.user.bot) {
                    nextMembers = [...nextMembers, memberId];
                    const sequence = history.reduce((max, entry) => Math.max(max, Number(entry.sequence) || 0), 0) + 1;
                    history = [...history, { userId: memberId, joinedAt: Date.now(), sequence }];
                }

                if (!nextMembers.length) return removeRoomNow(guild.id, channelId, 'Temporary voice channel became empty');

                const ownerLeft = oldState.channelId === channelId && newState.channelId !== channelId && memberId === room.owner_id;
                const owner = ownerLeft ? previousOwner(history, nextMembers, room.owner_id) : room.owner_id;
                if (!owner) return removeRoomNow(guild.id, channelId, 'No valid owner remained');

                const updated = saveRoom(room, { owner, members: nextMembers, history });
                await applyPermissions(updated, channel).catch((error) => console.error('[voice-room] Permission update failed:', error));
                await ensurePanel(updated, channel).catch((error) => console.error('[voice-room] Panel update failed:', error));
            }).catch((error) => console.error('[voice-room] Voice state update failed:', error));
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        try {
            if (interaction.isButton() && interaction.customId.startsWith('voice:')) {
                if (interaction.customId === 'voice:delete-cancel') return interaction.update({ content: 'Cancelled.', components: [] });
                if (interaction.customId.startsWith('voice:delete-confirm:')) {
                    const room = await requireOwner(interaction, interaction.customId.split(':')[2]);
                    if (!room) return;
                    await interaction.update({ content: '✅ Voice Channel deleted.', components: [] });
                    return removeRoom(room.guild_id, room.channel_id, 'Deleted by channel owner');
                }
                return handleButton(interaction);
            }

            if (interaction.isUserSelectMenu() && interaction.customId.startsWith('voice:target:')) return handleTarget(interaction);

            if (interaction.isStringSelectMenu() && interaction.customId.startsWith('voice:region:')) {
                const channelId = interaction.customId.split(':')[2];
                const room = await requireOwner(interaction, channelId);
                if (!room) return;
                await interaction.deferUpdate();
                const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
                if (!channel) return removeRoom(room.guild_id, room.channel_id);
                const region = interaction.values[0] === 'automatic' ? null : interaction.values[0];
                await channel.setRTCRegion(region);
                saveRoom(room, { region });
                return interaction.editReply({ content: '✅ Region updated.', components: [] });
            }

            if (interaction.isModalSubmit() && interaction.customId.startsWith('voice:modal:')) return handleModal(interaction);
        } catch (error) {
            console.error('[voice-room] Interaction failed:', error);
            if (interaction.deferred) {
                await interaction.editReply({ content: '❌ Unable to complete that action.', components: [] }).catch(() => {});
            } else if (!interaction.replied) {
                await interaction.reply({ content: '❌ Unable to complete that action.', ephemeral: true }).catch(() => {});
            }
        }
    });

    client.once(Events.ClientReady, async () => {
        await removeLegacyCommand().catch((error) => console.error('[voice-room] Legacy command cleanup failed:', error));
        for (const guild of client.guilds.cache.values()) {
            for (const room of getRooms.all(guild.id)) {
                await reconcileRoom(guild, room).catch((error) => console.error('[voice-room] Startup reconciliation failed:', error));
            }
        }
    });
}

module.exports = { initializeVoiceRoomSystem };