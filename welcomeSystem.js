const fs = require('fs');
const path = require('path');
const { AttachmentBuilder, EmbedBuilder, Events, PermissionFlagsBits } = require('discord.js');
const GIFEncoder = require('gif-encoder-2');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 336;
const ANIMATION_FRAME_COUNT = 24;
const FINAL_FRAME_COUNT = 20;
const FRAME_DELAY_MS = 100;
const WELCOME_CHANNEL_ID = '1115406068248481943';
const REFERENCE_IMAGE = path.join(__dirname, 'assets', 'welcome-reference.png');

function initializeWelcomeSystem(client, database, config = {}) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS welcome_members (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            join_number INTEGER NOT NULL,
            joined_at INTEGER NOT NULL,
            PRIMARY KEY (guild_id, user_id),
            UNIQUE (guild_id, join_number)
        );
        CREATE TABLE IF NOT EXISTS welcome_sequences (
            guild_id TEXT PRIMARY KEY,
            next_number INTEGER NOT NULL DEFAULT 1
        );
    `);

    const getStoredMember = database.prepare(
        'SELECT * FROM welcome_members WHERE guild_id = ? AND user_id = ?'
    );
    const allocateJoinNumber = database.transaction((guildId, userId) => {
        const existing = getStoredMember.get(guildId, userId);
        if (existing) return existing;

        const sequence = database.prepare(
            'SELECT next_number FROM welcome_sequences WHERE guild_id = ?'
        ).get(guildId);
        const joinNumber = sequence?.next_number || 1;
        const joinedAt = Date.now();

        if (sequence) {
            database.prepare(
                'UPDATE welcome_sequences SET next_number = ? WHERE guild_id = ?'
            ).run(joinNumber + 1, guildId);
        } else {
            database.prepare(
                'INSERT INTO welcome_sequences (guild_id, next_number) VALUES (?, ?)'
            ).run(guildId, joinNumber + 1);
        }

        database.prepare(`
            INSERT INTO welcome_members (guild_id, user_id, join_number, joined_at)
            VALUES (?, ?, ?, ?)
        `).run(guildId, userId, joinNumber, joinedAt);

        return { guild_id: guildId, user_id: userId, join_number: joinNumber, joined_at: joinedAt };
    });

    function resolveWelcomeChannel(guild) {
        return guild.channels.fetch(WELCOME_CHANNEL_ID).catch((error) => {
            console.error(`[welcome] Could not fetch channel ${WELCOME_CHANNEL_ID} in guild ${guild.id}:`, error.message);
            return null;
        });
    }

    function fitText(ctx, text, maxWidth, initialSize, weight = '700') {
        let size = initialSize;
        do {
            ctx.font = `${weight} ${size}px "Segoe UI", Arial, sans-serif`;
            size -= 2;
        } while (size > 18 && ctx.measureText(text).width > maxWidth);
        return size + 2;
    }

    function drawCoverImage(ctx, image, width, height) {
        const scale = Math.max(width / image.width, height / image.height);
        const drawWidth = image.width * scale;
        const drawHeight = image.height * scale;
        ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
        ctx.fillStyle = 'rgba(3, 12, 38, 0.68)';
        ctx.fillRect(0, 0, width, height);
    }

    function drawFallbackBackground(ctx, width, height) {
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#06112d');
        gradient.addColorStop(0.52, '#123b83');
        gradient.addColorStop(1, '#020918');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        ctx.save();
        ctx.globalAlpha = 0.2;
        ctx.strokeStyle = '#66b8ff';
        ctx.lineWidth = 2;
        for (let offset = -height; offset < width; offset += 90) {
            ctx.beginPath();
            ctx.moveTo(offset, height);
            ctx.lineTo(offset + height, 0);
            ctx.stroke();
        }
        ctx.restore();

        const glow = ctx.createRadialGradient(width * 0.83, height * 0.18, 5, width * 0.83, height * 0.18, 260);
        glow.addColorStop(0, 'rgba(57, 160, 255, 0.42)');
        glow.addColorStop(1, 'rgba(57, 160, 255, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, width, height);
    }

    function easeOutCubic(value) {
        const progress = Math.max(0, Math.min(1, value));
        return 1 - ((1 - progress) ** 3);
    }

    function drawText(ctx, text, x, y, size, alpha, weight = '700') {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = `${weight} ${size}px "Segoe UI", Arial, sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
        ctx.shadowBlur = 8;
        ctx.fillText(text, x, y);
        ctx.restore();
    }

    async function renderWelcomeAnimation(member, joinNumber) {
        let reference;
        if (fs.existsSync(REFERENCE_IMAGE)) {
            reference = await loadImage(REFERENCE_IMAGE).catch(() => null);
        }
        const avatar = await loadImage(member.displayAvatarURL({ extension: 'png', size: 256 })).catch(() => null);
        const encoder = new GIFEncoder(DEFAULT_WIDTH, DEFAULT_HEIGHT, 'neuquant', false);
        encoder.start();
        encoder.setRepeat(0);
        encoder.setDelay(FRAME_DELAY_MS);
        encoder.setQuality(10);

        for (let frame = 0; frame < ANIMATION_FRAME_COUNT + FINAL_FRAME_COUNT; frame += 1) {
            const canvas = createCanvas(DEFAULT_WIDTH, DEFAULT_HEIGHT);
            const ctx = canvas.getContext('2d');
            const time = Math.min(frame / (ANIMATION_FRAME_COUNT - 1) * 2.4, 2.4);
            if (reference) drawCoverImage(ctx, reference, DEFAULT_WIDTH, DEFAULT_HEIGHT);
            else drawFallbackBackground(ctx, DEFAULT_WIDTH, DEFAULT_HEIGHT);

            ctx.fillStyle = 'rgba(0, 0, 0, 0.26)';
            ctx.fillRect(0, 0, DEFAULT_WIDTH, DEFAULT_HEIGHT);
            ctx.strokeStyle = 'rgba(92, 190, 255, 0.75)';
            ctx.lineWidth = 3;
            ctx.strokeRect(24, 24, DEFAULT_WIDTH - 48, DEFAULT_HEIGHT - 48);

            const avatarSize = 132;
            const avatarX = 70;
            const avatarY = (DEFAULT_HEIGHT - avatarSize) / 2;
            const memberProgress = easeOutCubic((time - 1.2) / 0.8);
            ctx.save();
            ctx.globalAlpha = memberProgress;
            ctx.beginPath();
            ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2 + 7, 0, Math.PI * 2);
            ctx.strokeStyle = '#7dd3fc';
            ctx.lineWidth = 7;
            ctx.stroke();
            ctx.clip();
            if (avatar) ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
            else {
                ctx.fillStyle = '#1d4f91';
                ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
                ctx.fillStyle = '#ffffff';
                ctx.font = '700 60px "Segoe UI", Arial, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(member.displayName.charAt(0).toUpperCase(), avatarX + avatarSize / 2, avatarY + avatarSize / 2);
            }
            ctx.restore();
            ctx.textAlign = 'start';
            ctx.textBaseline = 'alphabetic';

            const left = 250;
            const maxTextWidth = DEFAULT_WIDTH - left - 55;
            const welcomeProgress = easeOutCubic((time - 0.3) / 0.7);
            const subtitleProgress = easeOutCubic((time - 0.8) / 0.7);
            const welcomeY = 104 + (1 - welcomeProgress) * 12;
            const subtitleY = 145 + (1 - subtitleProgress) * 12;
            const welcomeSize = fitText(ctx, 'WELCOME', maxTextWidth, 48);
            const subtitleSize = fitText(ctx, 'TO DRINK TEA', maxTextWidth, 30);
            drawText(ctx, 'WELCOME', left, welcomeY, welcomeSize, welcomeProgress, '700');
            drawText(ctx, 'TO DRINK TEA', left, subtitleY, subtitleSize, subtitleProgress, '600');

            const infoAlpha = memberProgress;
            const infoOffset = (1 - memberProgress) * 14;
            drawText(ctx, `MEMBER  ${member.displayName}`, left, 208 + infoOffset, fitText(ctx, `MEMBER  ${member.displayName}`, maxTextWidth, 22), infoAlpha, '600');
            drawText(ctx, `ACCOUNT SINCE  ${member.guild.name}`, left, 248 + infoOffset, fitText(ctx, `ACCOUNT SINCE  ${member.guild.name}`, maxTextWidth, 22), infoAlpha, '600');
            drawText(ctx, `MEMBER NUMBER  ${joinNumber}`, left, 288 + infoOffset, fitText(ctx, `MEMBER NUMBER  ${joinNumber}`, maxTextWidth, 22), infoAlpha, '600');
            ctx.globalAlpha = infoAlpha;
            ctx.fillStyle = 'rgba(125, 211, 252, 0.9)';
            ctx.fillRect(left, 304, Math.min(360, maxTextWidth), 3);
            ctx.globalAlpha = 1;
            encoder.addFrame(ctx);
        }
        encoder.finish();
        return encoder.out.getData();
    }

    client.on(Events.GuildMemberAdd, async (member) => {
        console.log(`[welcome] GuildMemberAdd received for ${member.user.tag} in ${member.guild.name}.`);
        try {
            const record = allocateJoinNumber(member.guild.id, member.id);
            const channel = await resolveWelcomeChannel(member.guild);
            if (!channel || !channel.isTextBased()) {
                console.error(`[welcome] Welcome channel is unavailable for guild ${member.guild.id}.`);
                return;
            }
            const botMember = member.guild.members.me || await member.guild.members.fetchMe().catch(() => null);
            const permissions = botMember ? channel.permissionsFor(botMember) : null;
            if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.AttachFiles)) {
                console.error(`[welcome] Bot lacks View Channel, Send Messages, or Attach Files in channel ${channel.id}.`);
                return;
            }
            const animation = await renderWelcomeAnimation(member, record.join_number);
            const attachment = new AttachmentBuilder(animation, { name: `welcome-${record.join_number}.gif` });
            await channel.send({
                files: [attachment],
                embeds: [new EmbedBuilder().setColor(0x1d9bf0).setDescription(`🎉 مرحبًا بك في ${member.guild.name}، <@${member.id}>!`)]
            });
        } catch (error) {
            console.error(`[welcome] Could not create welcome card for ${member.user.tag}:`, error);
        }
    });
}

module.exports = { initializeWelcomeSystem };
