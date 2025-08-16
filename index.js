require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const storage = require('./storage');

const { BOT_TOKEN, GROUP_ID, ADMIN_IDS, APP_BASE_URL, WEBHOOK_SECRET, PORT } = process.env;

if (!BOT_TOKEN || !GROUP_ID) {
    console.error('BOT_TOKEN and GROUP_ID must be provided!');
    process.exit(1);
}

const app = express();
const bot = new Telegraf(BOT_TOKEN);

const adminIds = (ADMIN_IDS || '').split(',').map(id => parseInt(id.trim(), 10));

// Middleware to check webhook secret
app.use(express.json());

app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

app.post('/tg/webhook', (req, res) => {
    const secretToken = req.header('X-Telegram-Bot-Api-Secret-Token');
    if (secretToken !== WEBHOOK_SECRET) {
        console.warn('Invalid webhook secret token');
        return res.sendStatus(403);
    }
    bot.handleUpdate(req.body, res);
});

// Bot logic
bot.start((ctx) => ctx.reply('👋 Добро пожаловать!\n\nЯ помогу вам связаться со службой поддержки. Просто отправьте мне сообщение, и я перешлю его нашим специалистам.\n\nПоддерживаемые типы сообщений:\n- Текст\n- Фото\n- Документы\n- Аудио\n- Видео\n- Голосовые сообщения\n- Стикеры'));

const userCardCache = new Map();

function canSendUserCard(userId) {
    const today = new Date().toISOString().split('T')[0];
    const lastSent = userCardCache.get(userId);
    if (lastSent === today) {
        return false;
    }
    userCardCache.set(userId, today);
    return true;
}

async function withRetry(fn, retries = 3, delay = 2000) {
    try {
        return await fn();
    } catch (error) {
        if (retries > 0 && (error.code === 429 || error.code >= 500)) {
            console.warn(`Telegram API error: ${error.description}. Retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return withRetry(fn, retries - 1, delay * 1.5);
        }
        throw error;
    }
}

bot.on('message', async (ctx) => {
    if (ctx.chat.type === 'private') {
        const user = ctx.from;
        await storage.upsertUser(user);

        let thread = await storage.getThreadByUser(user.id);

        if (!thread) {
            const title = `${user.first_name || ''} ${user.last_name || ''} @${user.username || ''} (${user.id})`.trim().slice(0, 128);
            try {
                const newTopic = await withRetry(() => ctx.telegram.createForumTopic(GROUP_ID, title));
                thread = {
                    thread_id: newTopic.message_thread_id,
                    group_id: GROUP_ID,
                    user_id: user.id,
                    title: title,
                    is_archived: false,
                };
                await storage.saveThread(thread);
            } catch (error) {
                console.error('Failed to create topic:', error);
                // TODO: Add fallback to "Overflow" topic
                return;
            }
        }

        if (canSendUserCard(user.id)) {
            const userCard = `👤 ${user.first_name || ''} ${user.last_name || ''} | @${user.username || ''} | id=${user.id}`;
            await withRetry(() => ctx.telegram.sendMessage(GROUP_ID, userCard, { message_thread_id: thread.thread_id }));
        }

        try {
            await withRetry(() => ctx.telegram.copyMessage(GROUP_ID, ctx.chat.id, ctx.message.message_id, { message_thread_id: thread.thread_id }));
        } catch (error) {
            console.error('Failed to copy message:', error);
            // Fallback for message types that cannot be copied
            try {
                if (ctx.message.text) {
                    await withRetry(() => ctx.telegram.sendMessage(GROUP_ID, ctx.message.text, { message_thread_id: thread.thread_id }));
                } else if (ctx.message.photo) {
                    const photo = ctx.message.photo[ctx.message.photo.length - 1];
                    await withRetry(() => ctx.telegram.sendPhoto(GROUP_ID, photo.file_id, { caption: ctx.message.caption, message_thread_id: thread.thread_id }));
                } else if (ctx.message.document) {
                    await withRetry(() => ctx.telegram.sendDocument(GROUP_ID, ctx.message.document.file_id, { caption: ctx.message.caption, message_thread_id: thread.thread_id }));
                } else if (ctx.message.audio) {
                    await withRetry(() => ctx.telegram.sendAudio(GROUP_ID, ctx.message.audio.file_id, { caption: ctx.message.caption, message_thread_id: thread.thread_id }));
                } else if (ctx.message.video) {
                    await withRetry(() => ctx.telegram.sendVideo(GROUP_ID, ctx.message.video.file_id, { caption: ctx.message.caption, message_thread_id: thread.thread_id }));
                } else if (ctx.message.voice) {
                    await withRetry(() => ctx.telegram.sendVoice(GROUP_ID, ctx.message.voice.file_id, { caption: ctx.message.caption, message_thread_id: thread.thread_id }));
                } else if (ctx.message.sticker) {
                    await withRetry(() => ctx.telegram.sendSticker(GROUP_ID, ctx.message.sticker.file_id, { message_thread_id: thread.thread_id }));
                }
            } catch (fallbackError) {
                console.error('Failed to send fallback message:', fallbackError);
                await withRetry(() => ctx.telegram.sendMessage(GROUP_ID, `❌ Не удалось переслать сообщение от пользователя ${user.id}`, { message_thread_id: thread.thread_id }));
            }
        }
    } else if (ctx.chat.id == GROUP_ID && ctx.message.is_topic_message && !ctx.from.is_bot) {
        const thread = await storage.getThreadById(ctx.message.message_thread_id);
        if (thread && !thread.is_archived) {
            try {
                if (ctx.message.text) {
                    await withRetry(() => ctx.telegram.sendMessage(thread.user_id, ctx.message.text));
                } else if (ctx.message.photo) {
                    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get highest resolution
                    await withRetry(() => ctx.telegram.sendPhoto(thread.user_id, photo.file_id, { caption: ctx.message.caption }));
                } else if (ctx.message.document) {
                    await withRetry(() => ctx.telegram.sendDocument(thread.user_id, ctx.message.document.file_id, { caption: ctx.message.caption }));
                } else if (ctx.message.audio) {
                    await withRetry(() => ctx.telegram.sendAudio(thread.user_id, ctx.message.audio.file_id, { caption: ctx.message.caption }));
                } else if (ctx.message.video) {
                    await withRetry(() => ctx.telegram.sendVideo(thread.user_id, ctx.message.video.file_id, { caption: ctx.message.caption }));
                } else if (ctx.message.voice) {
                    await withRetry(() => ctx.telegram.sendVoice(thread.user_id, ctx.message.voice.file_id, { caption: ctx.message.caption }));
                } else if (ctx.message.sticker) {
                    await withRetry(() => ctx.telegram.sendSticker(thread.user_id, ctx.message.sticker.file_id));
                }
            } catch (error) {
                if (error.code === 403) {
                    await ctx.reply('⚠️ Бот не может написать пользователю. Попросите клиента отправить /start.', { message_thread_id: thread.thread_id });
                } else {
                    console.error('Failed to send message to user:', error);
                }
            }
        }
    }
});

bot.command('id', async (ctx) => {
    if (ctx.chat.id == GROUP_ID && ctx.message.is_topic_message && adminIds.includes(ctx.from.id)) {
        const thread = await storage.getThreadById(ctx.message.message_thread_id);
        if (thread) {
            const userCard = `👤 id=${thread.user_id}`;
            await ctx.reply(userCard, { message_thread_id: thread.thread_id });
        }
    }
});

bot.command('rename', async (ctx) => {
    if (ctx.chat.id == GROUP_ID && ctx.message.is_topic_message && adminIds.includes(ctx.from.id)) {
        const thread = await storage.getThreadById(ctx.message.message_thread_id);
        if (thread) {
            const newTitle = ctx.message.text.split(' ').slice(1).join(' ').trim();
            if (newTitle) {
                try {
                    await withRetry(() => ctx.telegram.editForumTopic(GROUP_ID, thread.thread_id, { name: newTitle.slice(0, 128) }));
                    thread.title = newTitle;
                    await storage.saveThread(thread);
                } catch (error) {
                    console.error('Failed to rename topic:', error);
                }
            }
        }
    }
});

bot.command('close', async (ctx) => {
    if (ctx.chat.id == GROUP_ID && ctx.message.is_topic_message && adminIds.includes(ctx.from.id)) {
        const thread = await storage.getThreadById(ctx.message.message_thread_id);
        if (thread) {
            thread.is_archived = true;
            await storage.saveThread(thread);
            await ctx.reply('Тема закрыта.', { message_thread_id: thread.thread_id });
        }
    }
});

// ... rest of the bot logic will be implemented in the next steps

(async () => {
    await storage.initStorage();
    const webhookUrl = `${APP_BASE_URL}/tg/webhook`;
    await bot.telegram.setWebhook(webhookUrl, { secret_token: WEBHOOK_SECRET });
    console.log(`Webhook set to ${webhookUrl}`);

    app.listen(PORT || 8080, () => {
        console.log(`Server is running on port ${PORT || 8080}`);
    });
})();