const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    Events
} = require('discord.js');

const MIN_PLAYERS = 3;
const LOBBY_TIMEOUT_MS = 10 * 60 * 1000;
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const ROUND_POINTS = 5;

const CATEGORIES = {
    animal: { label: '🐾 حيوان', words: ['أسد', 'فيل', 'قطة', 'كلب', 'حصان', 'نمر', 'دلفين', 'أرنب', 'زرافة', 'بطريق'] },
    plant: { label: '🌱 نبات', words: ['وردة', 'نخلة', 'صبار', 'قمح', 'زيتون', 'تفاحة', 'برتقال', 'نعناع', 'ياسمين', 'فراولة'] },
    human: { label: '👤 إنسان', words: ['طبيب', 'معلم', 'طيار', 'نجار', 'بحار', 'طباخ', 'لاعب', 'مصور', 'مزارع', 'مهندس'] },
    object: { label: '🪨 جماد', words: ['كتاب', 'كرسي', 'هاتف', 'سيارة', 'مفتاح', 'ساعة', 'قلم', 'مصباح', 'حقيبة', 'مظلة'] }
};

function initializeOutOfTopic(client, database) {
    database.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_game_points
            ON users(guild_id, user_id);
    `);

    const games = new Map();
    const addPoints = database.transaction((guildId, userIds) => {
        const timestamp = Date.now();
        const ensureUser = database.prepare(`
            INSERT INTO users (guild_id, user_id, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id, user_id) DO NOTHING
        `);
        const updateUser = database.prepare(`
            UPDATE users
            SET points = points + ?, total_points_earned = total_points_earned + ?, updated_at = ?
            WHERE guild_id = ? AND user_id = ?
        `);
        const insertTransaction = database.prepare(`
            INSERT INTO transactions (guild_id, to_user_id, amount, type, created_at)
            VALUES (?, ?, ?, 'out_of_topic_win', ?)
        `);
        for (const userId of userIds) {
            ensureUser.run(guildId, userId, timestamp, timestamp);
            updateUser.run(ROUND_POINTS, ROUND_POINTS, timestamp, guildId, userId);
            insertTransaction.run(guildId, userId, ROUND_POINTS, timestamp);
        }
    });

    function randomItem(items) {
        return items[Math.floor(Math.random() * items.length)];
    }

    function shuffle(items) {
        const result = [...items];
        for (let index = result.length - 1; index > 0; index -= 1) {
            const randomIndex = Math.floor(Math.random() * (index + 1));
            [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
        }
        return result;
    }

    function mention(userId) {
        return `<@${userId}>`;
    }

    function normalizeText(value) {
        return value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ar');
    }

    function lobbyEmbed(game) {
        const players = game.players.map((player) => mention(player.id)).join('\n') || 'لا يوجد لاعبون بعد.';
        return new EmbedBuilder()
            .setColor(0x2f80ed)
            .setTitle('🎭 برا السالفة')
            .setDescription('انضموا إلى اللعبة، ثم يضغط صاحب اللعبة على بدء الجولة.')
            .addFields(
                { name: `اللاعبون (${game.players.length}/${MIN_PLAYERS}+ )`, value: players },
                { name: 'الحالة', value: game.players.length >= MIN_PLAYERS ? '✅ يمكن بدء الجولة' : `⏳ نحتاج ${MIN_PLAYERS - game.players.length} لاعب/لاعبين إضافيين` }
            )
            .setFooter({ text: 'تنتهي هذه اللوبي تلقائيًا بعد 10 دقائق من عدم النشاط.' });
    }

    function lobbyButtons(game) {
        return [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`oot:join:${game.channelId}`).setLabel('انضمام').setEmoji('🙋').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`oot:start:${game.channelId}`).setLabel('بدء الجولة').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(game.players.length < MIN_PLAYERS),
            new ButtonBuilder().setCustomId(`oot:cancel:${game.channelId}`).setLabel('إلغاء').setEmoji('🛑').setStyle(ButtonStyle.Danger)
        )];
    }

    function categoryButtons(game) {
        return [new ActionRowBuilder().addComponents(
            ...Object.entries(CATEGORIES).map(([key, category]) => new ButtonBuilder()
                .setCustomId(`oot:category:${game.channelId}:${key}`)
                .setLabel(category.label)
                .setStyle(ButtonStyle.Secondary))
        )];
    }

    function playerButtons(game, prefix, disabled = false) {
        const buttons = game.players.map((player) => new ButtonBuilder()
            .setCustomId(`oot:${prefix}:${game.channelId}:${player.id}`)
            .setLabel(player.displayName.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled));
        const rows = [];
        for (let index = 0; index < buttons.length; index += 5) {
            rows.push(new ActionRowBuilder().addComponents(buttons.slice(index, index + 5)));
        }
        return rows;
    }

    function clearTimer(game) {
        if (game.timer) clearTimeout(game.timer);
        game.timer = null;
    }

    function touch(game, duration = LOBBY_TIMEOUT_MS) {
        clearTimer(game);
        game.timer = setTimeout(() => cancelGame(game, '⏰ انتهت اللعبة بسبب عدم النشاط.'), duration);
    }

    async function sendChannel(game, payload) {
        const channel = await client.channels.fetch(game.channelId).catch(() => null);
        if (!channel?.isTextBased()) return null;
        return channel.send(payload).catch((error) => {
            console.error('[out-of-topic] Could not send channel message:', error);
            return null;
        });
    }

    async function cancelGame(game, reason) {
        if (!games.has(game.channelId)) return;
        clearTimer(game);
        games.delete(game.channelId);
        await sendChannel(game, { embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('🛑 انتهت اللعبة').setDescription(reason)] });
    }

    async function finishGame(game, winners, resultText) {
        if (!games.has(game.channelId)) return;
        clearTimer(game);
        games.delete(game.channelId);
        if (winners.length > 0) addPoints(game.guildId, winners);
        const winnerText = winners.length > 0 ? winners.map(mention).join('، ') : 'لا يوجد';
        await sendChannel(game, {
            embeds: [new EmbedBuilder()
                .setColor(0x2ecc71)
                .setTitle('🏆 انتهت الجولة')
                .setDescription(`${resultText}\n\nالفائزون: ${winnerText}\nحصل كل فائز على **${ROUND_POINTS} نقطة**.`)
                .setFooter({ text: 'يمكن بدء لعبة جديدة باستخدام !بره' })]
        });
    }

    async function sendSecretMessages(game) {
        const failed = [];
        await Promise.all(game.players.map(async (player) => {
            const user = await client.users.fetch(player.id).catch(() => null);
            if (!user) {
                failed.push(player.id);
                return;
            }
            const content = player.id === game.outsiderId
                ? 'أنت برا السالفة 🤫\nلا تعرف الكلمة السرية. حاول اكتشافها من الأسئلة دون أن ينكشف أمرك.'
                : `الكلمة السرية هي: **${game.secretWord}**\nلا ترسلها لأحد، واسأل وأجب بذكاء.`;
            await user.send({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle('🎭 لعبة برا السالفة').setDescription(content)] }).catch(() => failed.push(player.id));
        }));
        return failed;
    }

    function currentPlayer(game) {
        return game.turnOrder[game.turnIndex];
    }

    async function startTurn(game) {
        if (!games.has(game.channelId)) return;
        if (game.turnIndex >= game.turnOrder.length) {
            await startVoting(game);
            return;
        }
        game.phase = 'target';
        game.targetId = null;
        touch(game, TURN_TIMEOUT_MS);
        const player = currentPlayer(game);
        await sendChannel(game, {
            embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('❓ دور السؤال').setDescription(`${mention(player.id)} اختر لاعبًا لتوجه له سؤالك.`)],
            components: playerButtons(game, 'target')
        });
    }

    async function advanceTurn(game) {
        game.turnIndex += 1;
        await startTurn(game);
    }

    async function startVoting(game) {
        clearTimer(game);
        game.phase = 'voting';
        game.votes.clear();
        touch(game, TURN_TIMEOUT_MS);
        await sendChannel(game, {
            embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle('🗳️ وقت التصويت').setDescription('صوّتوا للشخص الذي تظنونه برا السالفة. كل لاعب يصوّت مرة واحدة.')],
            components: playerButtons(game, 'vote')
        });
    }

    async function resolveVotes(game) {
        const counts = new Map();
        for (const votedId of game.votes.values()) counts.set(votedId, (counts.get(votedId) || 0) + 1);
        const maxVotes = Math.max(...counts.values());
        const leaders = [...counts.entries()].filter(([, count]) => count === maxVotes).map(([userId]) => userId);
        const identified = leaders.length === 1 && leaders[0] === game.outsiderId;
        if (!identified) {
            await finishGame(game, [game.outsiderId], `تم التصويت بشكل خاطئ، وبرا السالفة هو ${mention(game.outsiderId)}.`);
            return;
        }
        game.phase = 'guess';
        clearTimer(game);
        touch(game, TURN_TIMEOUT_MS);
        const outsider = await client.users.fetch(game.outsiderId).catch(() => null);
        if (!outsider) {
            await finishGame(game, game.players.filter((player) => player.id !== game.outsiderId).map((player) => player.id), `تم كشف برا السالفة، لكنه لم يستطع إرسال تخمين.`);
            return;
        }
        await outsider.send(`تم كشفك! أرسل تخمينك للكلمة السرية هنا خلال 5 دقائق.\nالفئة: ${CATEGORIES[game.category].label}`).catch(() => null);
        await sendChannel(game, { embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle('🎯 فرصة التخمين').setDescription(`${mention(game.outsiderId)} تم كشفك. لديك فرصة أخيرة لتخمين الكلمة، وقد أرسلت لك التعليمات في الخاص.`)] });
    }

    async function chooseCategory(interaction, game, categoryKey) {
        if (interaction.user.id !== game.creatorId) {
            await interaction.reply({ content: 'فقط صاحب اللعبة يختار الفئة.', ephemeral: true });
            return;
        }
        game.category = categoryKey;
        game.secretWord = randomItem(CATEGORIES[categoryKey].words);
        game.outsiderId = randomItem(game.players).id;
        game.turnOrder = shuffle(game.players).map((player) => player.id);
        game.turnIndex = 0;
        game.phase = 'sending';
        const failed = await sendSecretMessages(game);
        if (failed.length > 0) {
            game.players = game.players.filter((player) => !failed.includes(player.id));
            if (game.players.length < MIN_PLAYERS || failed.includes(game.outsiderId)) {
                await interaction.update({ components: [] });
                await cancelGame(game, 'تعذر إرسال الرسائل الخاصة لأحد اللاعبين، لذلك أُغلقت اللعبة. فعّل استقبال الرسائل الخاصة ثم حاول مرة أخرى.');
                return;
            }
            game.turnOrder = game.turnOrder.filter((id) => !failed.includes(id));
        }
        await interaction.update({ components: [] });
        await sendChannel(game, { embeds: [new EmbedBuilder().setColor(0x1abc9c).setTitle('✅ بدأت الجولة').setDescription('تم إرسال الكلمات في الخاص. سيبدأ ترتيب الأسئلة الآن.') ] });
        await startTurn(game);
    }

    async function handleButton(interaction) {
        const parts = interaction.customId.split(':');
        if (parts[0] !== 'oot') return;
        const activeGame = games.get(parts[2]);
        if (!activeGame) {
            await interaction.reply({ content: 'هذه اللعبة انتهت أو لم تعد موجودة.', ephemeral: true });
            return;
        }
        if (parts[1] === 'join') {
            if (activeGame.phase !== 'lobby') return interaction.reply({ content: 'انتهت فترة الانضمام.', ephemeral: true });
            if (activeGame.players.some((player) => player.id === interaction.user.id)) return interaction.reply({ content: 'أنت منضم بالفعل.', ephemeral: true });
            if (interaction.user.bot) return interaction.reply({ content: 'البوتات لا يمكنها اللعب.', ephemeral: true });
            activeGame.players.push({ id: interaction.user.id, displayName: interaction.member?.displayName || interaction.user.username });
            touch(activeGame);
            await interaction.update({ embeds: [lobbyEmbed(activeGame)], components: lobbyButtons(activeGame) });
            return;
        }
        if (parts[1] === 'cancel') {
            if (interaction.user.id !== activeGame.creatorId) return interaction.reply({ content: 'فقط صاحب اللعبة يستطيع إلغاءها.', ephemeral: true });
            await interaction.update({ components: [] });
            await cancelGame(activeGame, 'تم إلغاء اللعبة من صاحبها.');
            return;
        }
        if (parts[1] === 'start') {
            if (interaction.user.id !== activeGame.creatorId) return interaction.reply({ content: 'فقط صاحب اللعبة يستطيع بدء الجولة.', ephemeral: true });
            if (activeGame.players.length < MIN_PLAYERS) return interaction.reply({ content: `يجب أن ينضم ${MIN_PLAYERS} لاعبين على الأقل.`, ephemeral: true });
            activeGame.phase = 'category';
            clearTimer(activeGame);
            touch(activeGame);
            await interaction.update({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('📚 اختر الفئة').setDescription('صاحب اللعبة يختار الفئة السرية.')], components: categoryButtons(activeGame) });
            return;
        }
        if (parts[1] === 'category') {
            await chooseCategory(interaction, activeGame, parts[3]);
            return;
        }
        if (parts[1] === 'target') {
            if (activeGame.phase !== 'target' || interaction.user.id !== currentPlayer(activeGame)) return interaction.reply({ content: 'ليس دورك الآن.', ephemeral: true });
            if (interaction.user.id === parts[3]) return interaction.reply({ content: 'اختر لاعبًا آخر.', ephemeral: true });
            activeGame.targetId = parts[3];
            activeGame.phase = 'question';
            touch(activeGame, TURN_TIMEOUT_MS);
            await interaction.update({ components: [] });
            await sendChannel(activeGame, { embeds: [new EmbedBuilder().setColor(0x3498db).setDescription(`${mention(interaction.user.id)} اكتب سؤالك الآن إلى ${mention(parts[3])}.`)] });
            return;
        }
        if (parts[1] === 'vote') {
            if (activeGame.phase !== 'voting') return interaction.reply({ content: 'انتهى التصويت.', ephemeral: true });
            if (activeGame.votes.has(interaction.user.id)) return interaction.reply({ content: 'صوّت بالفعل.', ephemeral: true });
            activeGame.votes.set(interaction.user.id, parts[3]);
            await interaction.reply({ content: 'تم تسجيل صوتك.', ephemeral: true });
            if (activeGame.votes.size >= activeGame.players.length) await resolveVotes(activeGame);
        }
    }

    client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot) return;
        if (!message.guild) {
            for (const game of games.values()) {
                if (game.phase !== 'guess' || game.outsiderId !== message.author.id) continue;
                const guess = message.content.trim();
                if (!guess) return;
                if (normalizeText(guess) === normalizeText(game.secretWord)) {
                    await finishGame(game, [game.outsiderId], `خمن برا السالفة الكلمة بشكل صحيح: **${game.secretWord}**.`);
                } else {
                    await finishGame(game, game.players.filter((player) => player.id !== game.outsiderId).map((player) => player.id), `كان التخمين خاطئًا. الكلمة السرية كانت **${game.secretWord}**.`);
                }
                return;
            }
            return;
        }
        const game = games.get(message.channel.id);
        if (message.content.trim() === '!الغاء') return;
        if (!game || game.phase !== 'question' || message.author.id !== currentPlayer(game)) return;
        const question = message.content.trim();
        if (!question) return;
        const normalized = normalizeText(question);
        if (game.questions.has(normalized)) {
            await message.reply('تم استخدام هذا السؤال من قبل في هذه الجولة. اكتب سؤالًا مختلفًا.');
            return;
        }
        game.questions.add(normalized);
        game.phase = 'answer';
        touch(game, TURN_TIMEOUT_MS);
        await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('❓ سؤال جديد').setDescription(`${mention(message.author.id)} إلى ${mention(game.targetId)}:\n\n**${question}**\n\n${mention(game.targetId)} أرسل إجابتك الآن.`)] });
    });

    client.on(Events.InteractionCreate, (interaction) => {
        if (!interaction.isButton() || !interaction.customId.startsWith('oot:')) return;
        handleButton(interaction).catch((error) => console.error('[out-of-topic] Button failed:', error));
    });

    client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot || !message.guild || message.content.trim() === '!الغاء') return;
        const game = games.get(message.channel.id);
        if (!game || game.phase !== 'answer' || message.author.id !== game.targetId) return;
        game.phase = 'target';
        await message.channel.send(`✅ ${mention(message.author.id)} أجاب. ننتقل للسؤال التالي.`);
        await advanceTurn(game);
    });

    client.on(Events.GuildMemberRemove, (member) => {
        const game = games.get(member.guild.id) || [...games.values()].find((item) => item.guildId === member.guild.id && item.players.some((player) => player.id === member.id));
        if (!game || !game.players.some((player) => player.id === member.id)) return;
        game.players = game.players.filter((player) => player.id !== member.id);
        if (game.outsiderId === member.id || game.players.length < MIN_PLAYERS) {
            cancelGame(game, 'خرج لاعب من اللعبة، لذلك أُغلقت الجولة الحالية.').catch((error) => console.error('[out-of-topic] Leave cleanup failed:', error));
            return;
        }
        game.turnOrder = game.turnOrder.filter((userId) => userId !== member.id);
        game.votes.delete(member.id);
    });

    client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot || !message.guild) return;
        const command = message.content.trim();
        const activeGame = games.get(message.channel.id);

        if (command === '!الغاء') {
            if (!activeGame) {
                await message.reply('لا توجد لعبة نشطة لإلغائها.').catch(() => null);
                return;
            }
            if (message.author.id !== activeGame.creatorId) {
                await message.reply('فقط صاحب اللعبة يستطيع إلغاءها.').catch(() => null);
                return;
            }
            await cancelGame(activeGame, 'تم إلغاء اللعبة من صاحبها.');
            return;
        }

        if (command !== '!بره') return;
        if (games.has(message.channel.id)) {
            await message.reply('هناك لعبة جارية في هذه القناة بالفعل.').catch(() => null);
            return;
        }
        const game = {
            channelId: message.channel.id,
            guildId: message.guild.id,
            creatorId: message.author.id,
            players: [{ id: message.author.id, displayName: message.member?.displayName || message.author.username }],
            phase: 'lobby',
            timer: null,
            questions: new Set(),
            votes: new Map(),
            turnOrder: [],
            turnIndex: 0
        };
        games.set(game.channelId, game);
        touch(game);
        await message.channel.send({ embeds: [lobbyEmbed(game)], components: lobbyButtons(game) });
    });
}

module.exports = { initializeOutOfTopic };