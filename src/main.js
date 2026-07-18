import { CheerioCrawler, log } from 'crawlee';
import { Actor } from 'apify';

await Actor.init();

const input = await Actor.getInput() || {};
const maxItems = input.maxItems || 500;
const maxRunTimeMinutes = input.maxRunTimeMinutes || 5;

// sansadhan.com trade categories and city pages
const START_URLS = [
    'https://www.sansadhan.com/trade/healthcare-products/',
    'https://www.sansadhan.com/trade/electronicscomponents/',
    'https://www.sansadhan.com/trade/garmentsapparels/',
    'https://www.sansadhan.com/trade/industrialsupplies/',
    'https://www.sansadhan.com/trade/gemsjewellery/',
    'https://www.sansadhan.com/trade/rubber-rubber-products/',
    'https://www.sansadhan.com/kolkata/',
    'https://www.sansadhan.com/hyderabad/',
    'https://www.sansadhan.com/lucknow/',
];

// Noise words to filter out (UI elements, not real listings)
const NOISE = ['show filters', 'login', 'register', 'list your business', 'see all', 'search', 'browse', 'select a category', 'home', 'about us', 'contact us', 'privacy policy', 'speak now', 'sansadhan', 'join now', 'grab special', 'click here', 'try us', 'pay bills', 'customer support', 'disclaimer', 'free listing', 'advertising'];

let totalItems = 0;

const crawler = new CheerioCrawler({
    maxRequestRetries: 2,
    maxConcurrency: 3,
    async requestHandler({ $, request, enqueueLinks }) {
        if (totalItems >= maxItems) return;

        const isDetailPage = request.userData.type === 'detail' || request.url.includes('/yp/');

        if (isDetailPage) {
            // DETAIL PAGE: extract full contact info
            log.info(`Detail: ${request.url}`);

            // Name: sansadhan.com puts the business name in a bold/heading at the top
            // but also has "Speak Now" CTA in h-tags. Filter those out.
            let name = '';
            $('h1, h2, h3, strong, b').each((_, el) => {
                const text = $(el).text().trim();
                if (text.length >= 4 && text.length <= 100
                    && !text.toLowerCase().includes('speak now')
                    && !text.toLowerCase().includes('sansadhan')
                    && !text.toLowerCase().includes('popular search')
                    && !text.toLowerCase().includes('get in touch')
                    && !text.toLowerCase().includes('our customer')
                    && !text.toLowerCase().includes('connect :')
                    && !text.toLowerCase().includes('write a review')) {
                    name = text;
                    return false;
                }
            });
            if (!name) name = request.userData.name || '';
            if (!name || name.length < 3) {
                name = $('title').text().replace(/\s*[-|].*$/, '').trim();
            }
            if (!name || name.length < 3) {
                log.debug(`Skipping detail page with no name: ${request.url}`);
                return;
            }

            // Phone - extract from tel: links, WhatsApp links, or body text
            let phone = '';
            // Method 1: tel: links
            $('a[href^="tel:"]').each((_, el) => {
                const p = ($(el).attr('href') || '').replace('tel:', '').trim();
                if (p.replace(/\D/g, '').length >= 8) { phone = p; return false; }
            });
            // Method 2: WhatsApp links (wa.me/91XXXXXXXXXX)
            if (!phone) {
                $('a[href*="wa.me/"]').each((_, el) => {
                    const href = $(el).attr('href') || '';
                    const waMatch = href.match(/wa\.me\/(\d{10,13})/);
                    if (waMatch) {
                        phone = waMatch[1].startsWith('91') ? '+' + waMatch[1] : waMatch[1];
                        return false;
                    }
                });
            }
            // Method 3: Look for Indian mobile pattern in page text (10 digits starting with 6-9)
            if (!phone) {
                const bodyText = $('body').text();
                const phoneMatch = bodyText.match(/(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/);
                if (phoneMatch) phone = phoneMatch[0].trim();
            }

            // Email
            let email = '';
            $('a[href^="mailto:"]').each((_, el) => {
                email = $(el).text().trim() || $(el).attr('href').replace('mailto:', '');
                return false;
            });

            // Website (external link) - exclude sansadhan.com, facebook, google, twitter, whatsapp
            let website = '';
            $('a[href^="http"]').each((_, el) => {
                const href = $(el).attr('href') || '';
                if (!href.includes('sansadhan.com') && !href.includes('facebook.com') && !href.includes('google.com') && !href.includes('twitter.com') && !href.includes('wa.me') && !href.includes('instagram.com') && !href.includes('linkedin.com') && !href.includes('youtube.com') && !href.includes('yuvaninfomedia.com')) {
                    website = href;
                    return false;
                }
            });

            // Address - Indian format (ends with India or 6-digit pincode)
            let address = '';
            const bodyText = $('body').text();
            const addrMatch = bodyText.match(/(\d+[^.]*?(?:India|\d{6}))/i);
            if (addrMatch) address = addrMatch[1].replace(/\s+/g, ' ').trim().slice(0, 200);

            // Category
            const category = request.userData.category || 'Manufacturing';

            await Actor.pushData([{
                name,
                phone: phone || 'Not Found',
                email: email || 'Not Found',
                address: address || request.userData.address || 'Not Found',
                website: website || 'Not Found',
                category,
                sourceUrl: request.url,
            }]);
            totalItems++;
            log.info(`✅ ${name} — phone: ${phone || 'N/A'}, addr: ${address.slice(0, 50)}...`);
            return;
        }

        // LISTING PAGE: find business cards and enqueue detail pages
        log.info(`Listing: ${request.url}`);
        let enqueued = 0;

        // Find all links that point to detail pages (/yp/business-name-city)
        $('a').each((i, el) => {
            if (totalItems + enqueued >= maxItems) return false;

            const href = $(el).attr('href') || '';
            const text = $(el).text().trim().replace(/\s+/g, ' ');

            // Detail pages match: /yp/business-name-city
            if (!href.match(/\/yp\/[a-z0-9-]+/i)) return;
            if (text.length < 4 || text.length > 120) return;

            // Filter noise
            if (NOISE.some(n => text.toLowerCase().includes(n))) return;

            // Get address context from parent
            const parent = $(el).closest('div, article, li, td');
            const parentText = parent.text().replace(text, '').replace(/\s+/g, ' ').trim();
            let address = '';
            const indiaMatch = parentText.match(/([^.]{5,}(?:India|\d{6}))/i);
            if (indiaMatch) address = indiaMatch[1].trim().slice(0, 200);

            const fullUrl = href.startsWith('http') ? href : `https://www.sansadhan.com${href}`;

            crawler.addRequests([{
                url: fullUrl,
                userData: {
                    type: 'detail',
                    name: text,
                    address,
                    category: 'Manufacturing',
                },
            }]);
            enqueued++;
        });

        log.info(`Enqueued ${enqueued} detail pages from ${request.url}`);

        // Also enqueue subcategory/pagination links
        if (totalItems + enqueued < maxItems) {
            await enqueueLinks({
                globs: [
                    'https://www.sansadhan.com/trade/**',
                    'https://www.sansadhan.com/yp/**',
                    'https://www.sansadhan.com/kolkata/**',
                    'https://www.sansadhan.com/hyderabad/**',
                    'https://www.sansadhan.com/lucknow/**',
                ],
                exclude: ['**/user/**', '**/login**', '**/register**', '**/contact**'],
            });
        }
    },
});

// Kill switch
setTimeout(() => {
    log.warning(`Maximum run time of ${maxRunTimeMinutes} minutes reached. Tearing down.`);
    crawler.teardown();
}, maxRunTimeMinutes * 60 * 1000);

log.info('Starting India B2B Manufacturers & Suppliers Scraper (sansadhan.com)...');
await crawler.run(START_URLS);

log.info(`🎉 Done. Total listings extracted: ${totalItems}`);
await Actor.exit();
