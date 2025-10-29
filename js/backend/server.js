const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
// load env early
require('dotenv').config();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// OpenAI: we'll call the REST API directly via axios using the API key from env

// Cache
let siteContentCache = null;
let lastCrawlTime = null;

// Main FAQ Endpoint
app.post('/api/faq-search', async (req, res) => {
    try {
        const { question, siteUrl } = req.body;
        
        // اول چک کن سوال مربوط به سایت هست یا سوال عمومی
        const isGeneralQuestion = checkIfGeneralQuestion(question);
        
        if (isGeneralQuestion) {
            // سوال عمومی - مستقیم به ChatGPT
            console.log('General question detected, using ChatGPT...');
            const answer = await askChatGPT(question, null);
            return res.json({
                success: true,
                answer: answer,
                type: 'general'
            });
        }
        
        // سوال مربوط به سایت - جستجو در محتوا
        console.log('Site-related question, searching content...');
        
        // بروزرسانی کش در صورت نیاز
        if (!siteContentCache || shouldUpdateCache()) {
            console.log('Updating site content cache...');
            siteContentCache = await crawlLocalSite();
            lastCrawlTime = Date.now();
        }
        
        // پیدا کردن محتوای مرتبط
        const relevantContent = findRelevantContent(question, siteContentCache);
        
        // ساخت پاسخ با ChatGPT بر اساس محتوای سایت
        const answer = await askChatGPT(question, relevantContent);
        
        res.json({
            success: true,
            answer: answer,
            type: 'site-specific',
            sources: relevantContent.slice(0, 3).map(c => c.url)
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            success: false,
            answer: 'متأسفانه مشکلی پیش آمد. لطفاً دوباره تلاش کنید.'
        });
    }
});

// بررسی نوع سوال (عمومی یا مربوط به سایت)
function checkIfGeneralQuestion(question) {
    const siteKeywords = [
        'محصول', 'قیمت', 'خدمات', 'شرکت', 'نوآوران', 'سایت',
        'سفارش', 'خرید', 'پشتیبانی', 'تماس', 'آدرس'
    ];
    
    const generalPhrases = [
        'سلام', 'خوبی', 'چطوری', 'هوا', 'امروز', 'دیروز',
        'چیست', 'چه کسی', 'چگونه', 'کی', 'کجا'
    ];
    
    const questionLower = question.toLowerCase();
    
    // اگر کلمات کلیدی سایت داشت
    for (const keyword of siteKeywords) {
        if (questionLower.includes(keyword)) {
            return false; // مربوط به سایت
        }
    }
    
    // اگر خیلی کوتاه بود احتمالا سلام احوالپرسی است
    if (question.length < 15) {
        return true; // عمومی
    }
    
    return false; // پیش‌فرض: مربوط به سایت
}

// کرال کردن سایت محلی
async function crawlLocalSite() {
    const fs = require('fs').promises;
    const content = [];
    
    // لیست فایل‌های HTML
    const htmlFiles = [
        'index.html',
        'products.html',
        'about.html',
        'contact.html'
    ];
    
    for (const file of htmlFiles) {
        try {
            // HTML files live in the project root (two levels up from this backend folder)
            const filePath = path.join(__dirname, '..', '..', file);
            const html = await fs.readFile(filePath, 'utf8');
            const $ = cheerio.load(html);
            
            // حذف اسکریپت‌ها و استایل‌ها
            $('script').remove();
            $('style').remove();
            
            const pageContent = {
                url: `/${file}`,
                title: $('title').text() || file,
                h1: $('h1').map((i, el) => $(el).text()).get().join(' '),
                h2: $('h2').map((i, el) => $(el).text()).get().join(' '),
                h3: $('h3').map((i, el) => $(el).text()).get().join(' '),
                paragraphs: $('p').map((i, el) => $(el).text()).get().join(' '),
                lists: $('li').map((i, el) => $(el).text()).get().join(' '),
                content: $('body').text().replace(/\s+/g, ' ').trim()
            };
            
            content.push(pageContent);
            console.log(`Crawled: ${file}`);
            
        } catch (error) {
            console.error(`Error crawling ${file}:`, error.message);
        }
    }
    
    return content;
}

// پیدا کردن محتوای مرتبط
function findRelevantContent(question, content) {
    const questionWords = question.toLowerCase().split(/\s+/);
    
    const scoredContent = content.map(page => {
        let score = 0;
        const pageText = (
            page.title + ' ' + 
            page.h1 + ' ' + 
            page.h2 + ' ' + 
            page.h3 + ' ' + 
            page.content
        ).toLowerCase();
        
        // امتیازدهی بر اساس تطابق کلمات
        questionWords.forEach(word => {
            if (word.length > 2) {
                const matches = (pageText.match(new RegExp(word, 'g')) || []).length;
                score += matches;
                
                // امتیاز بیشتر برای تطابق در عناوین
                if (page.title.toLowerCase().includes(word)) score += 10;
                if (page.h1.toLowerCase().includes(word)) score += 8;
                if (page.h2.toLowerCase().includes(word)) score += 5;
            }
        });
        
        return { ...page, score };
    });
    
    return scoredContent
        .sort((a, b) => b.score - a.score)
        .filter(page => page.score > 0)
        .slice(0, 5);
}

// سوال از ChatGPT
async function askChatGPT(question, relevantContent) {
    try {
        let systemPrompt = `شما دستیار هوشمند سایت "شرکت نوآوران دیجیتال" هستید.
        شخصیت: دوستانه، حرفه‌ای و کمک‌کننده
        زبان: فارسی روان و رسمی-صمیمی
        
        وظایف شما:
        1. پاسخ به سوالات کاربران به صورت دقیق و مفید
        2. معرفی محصولات و خدمات شرکت در صورت نیاز
        3. راهنمایی کاربران برای استفاده از سایت`;
        
        let userPrompt = question;
        
        if (relevantContent && relevantContent.length > 0) {
            // اگر محتوای مرتبط داریم
            const context = relevantContent.map(page => 
                `📄 ${page.title}:\n${page.content.substring(0, 500)}`
            ).join('\n\n---\n\n');
            
            userPrompt = `بر اساس اطلاعات زیر از سایت، به این سوال پاسخ دهید:
            
سوال: ${question}

اطلاعات سایت:
${context}

لطفا پاسخی دقیق و مرتبط با محتوای سایت ارائه دهید.`;
        }
        
        // Call OpenAI REST API via axios (avoid client compatibility issues)
        // Build the request body so we can retry if the chosen model rejects some params (e.g., temperature)
        // Use a broadly supported chat model that accepts temperature
        const modelName = 'gpt-5';
            const requestBody = {
                model: modelName,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_completion_tokens: 500
            };

            // Some models (for example gpt-5-nano) reject custom temperature values; only include temperature
            // for models that generally support it (e.g., gpt-3.5-series). This prevents unsupported_value errors.
            if (!modelName.startsWith('gpt-5')) {
                requestBody.temperature = 0.7;
            }

        try {
            const resp = await axios.post('https://api.openai.com/v1/chat/completions', requestBody, {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            const completion = resp.data;
            return completion.choices && completion.choices[0] && completion.choices[0].message
                ? completion.choices[0].message.content
                : '';
        } catch (err) {
            // If the model doesn't support the 'temperature' value, retry without it or with default
            const errData = err.response && err.response.data ? err.response.data : null;
            if (errData && errData.error && errData.error.code === 'unsupported_value' && errData.error.param === 'temperature') {
                console.warn('Model rejected temperature value, retrying without temperature...');
                // remove temperature and retry
                const fallbackBody = { ...requestBody };
                delete fallbackBody.temperature;

                try {
                    const retryResp = await axios.post('https://api.openai.com/v1/chat/completions', fallbackBody, {
                        headers: {
                            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    const completion = retryResp.data;
                    return completion.choices && completion.choices[0] && completion.choices[0].message
                        ? completion.choices[0].message.content
                        : '';
                } catch (retryErr) {
                    console.error('Retry after removing temperature failed:', retryErr.response ? retryErr.response.data : retryErr.message || retryErr);
                    throw retryErr;
                }
            }

            // rethrow original error to be handled by outer catch
            throw err;
        }
        
    } catch (error) {
        // Improved error logging to see API response
        console.error('ChatGPT Error:', error.response ? error.response.data : (error.message || error));

        // Fallback پاسخ
        if (relevantContent && relevantContent.length > 0) {
            return `بر اساس اطلاعات سایت:

${relevantContent[0].title}
${relevantContent[0].content.substring(0, 300)}...

برای اطلاعات بیشتر به صفحه ${relevantContent[0].url} مراجعه کنید.`;
        }

        return 'متأسفانه در حال حاضر امکان پاسخگویی نیست. لطفا با شماره 021-12345678 تماس بگیرید.';
    }
}

// چک کردن نیاز به بروزرسانی کش
function shouldUpdateCache() {
    if (!lastCrawlTime) return true;
    const hoursSinceLastCrawl = (Date.now() - lastCrawlTime) / (1000 * 60 * 60);
    return hoursSinceLastCrawl > 1; // هر 1 ساعت
}

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📱 Website: http://localhost:${PORT}/index.html`);
    console.log(`🤖 AI Assistant: http://localhost:${PORT}/faq.html`);
});