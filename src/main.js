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
const NOISE = ['show filters', 'login', 'register', 'list your business', 'see all', 'search', 'browse', 'select a category', 'home', 'about us', 'contact us', 'privacy policy'];

let totalItems = 0;

const crawler = new CheerioCrawler({
    maxRequestRetries: 2,
    maxConcurrency: 3,
    async requestHandler({ $, request, enqueueLinks }) {
        if (totalItems >= maxItems) return;

        const isDetailPage = request.userData.type === 'detail';

        if (isDetailPage) {
            // DETAIL PAGE: extract full contact info
            log.info(`Detail: ${request.url}`);

            const name = $('h1, h2').first().text().trim() || request.userData.name || '';
            if (!name || name.length < 3) return;

            // Phone - Indian format
            let phone = '';
            $('a[href^="tel:"]').each((_, el) => {
                phone = $(el).text().trim() || $(el).attr('href').replace('tel:', '');
                return false;
            });
            if (!phone) {
                const bodyText = $('body').text();
                const phoneMatch = bodyText.match(/(?:\+91|0)\s?\d{2,5}[\s-]?\d{3,7}[\s-]?\d{0,4}/);
                if (phoneMatch) phone = phoneMatch[0].trim();
            }

            // Email
            let email = '';
            $('a[href^="mailto:"]').each((_, el) => {
                email = $(el).text().trim() || $(el).attr('href').replace('mailto:', '');
                return false;
            });

            // Website (external link) - exclude sansadhan.com, facebook, google, twitter
            let website = '';
            $('a[href^="http"]').each((_, el) => {
                const href = $(el).attr('href') || '';
                if (!href.includes('sansadhan.com') && !href.includes('facebook.com') && !href.includes('google.com') && !href.includes('twitter.com')) {
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
