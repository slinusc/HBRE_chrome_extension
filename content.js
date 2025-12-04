chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'scrape') {
        try {
            let data;
            if (window.location.hostname.includes('homegate.ch')) {
                data = scrapeHomegate();
            } else {
                data = scrapeImmoScout();
            }
            sendResponse({ data: data });
        } catch (e) {
            console.error('Scraping error:', e);
            sendResponse({ error: e.message });
        }
    }
    return true; // Keep channel open for async response
});

function scrapeImmoScout() {
    const data = {};

    // 1. Basic Info
    data.detail_url = window.location.href;
    const urlMatch = window.location.href.match(/\/(\d+)$/);
    data.listing_id = urlMatch ? urlMatch[1] : null;
    data.detailed = true;
    data.scraped_at = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Defaults
    data.column_id = "nicht_bewertet";
    data.position = 9999;
    data.rating = "";

    // 2. JSON-LD Extraction
    let jsonLd = {};
    try {
        const script = document.querySelector('script[type="application/ld+json"][data-vmid="ld-json-listing"]');
        if (script) {
            jsonLd = JSON.parse(script.textContent);
        }
    } catch (e) {
        console.warn('JSON-LD parse error', e);
    }

    // Title
    data.title = jsonLd.name || document.querySelector('h1')?.innerText?.trim() || document.title;

    // Description
    const descHeader = Array.from(document.querySelectorAll('h2')).find(h => h.innerText.includes('Beschreibung'));
    if (descHeader && descHeader.nextElementSibling) {
        data.description = descHeader.nextElementSibling.innerText.trim();
    } else {
        data.description = jsonLd.description || "";
    }

    // Address
    const addressEl = document.querySelector('address');
    if (addressEl) {
        data.address = addressEl.innerText.replace(/\n/g, ', ').trim();
    } else {
        const addrHeader = Array.from(document.querySelectorAll('h2')).find(h => h.innerText.includes('Adresse'));
        if (addrHeader && addrHeader.nextElementSibling) {
            data.address = addrHeader.nextElementSibling.innerText.replace(/\n/g, ', ').trim();
        }
    }

    // Features
    data.features = [];
    const featuresHeader = Array.from(document.querySelectorAll('h2')).find(h => h.innerText.includes('Eigenschaften') || h.innerText.includes('Ausstattung'));
    if (featuresHeader && featuresHeader.nextElementSibling) {
        const listItems = featuresHeader.nextElementSibling.querySelectorAll('li p, li');
        listItems.forEach(li => {
            const text = li.innerText.trim();
            if (text) data.features.push(text);
        });
    }

    // Main Attributes
    data.main_attributes = {};
    const mainAttrHeader = Array.from(document.querySelectorAll('h2')).find(h => h.innerText.includes('Hauptangaben'));
    if (mainAttrHeader && mainAttrHeader.nextElementSibling) {
        const dl = mainAttrHeader.nextElementSibling.querySelector('dl') || mainAttrHeader.nextElementSibling;
        const dts = dl.querySelectorAll('dt');
        const dds = dl.querySelectorAll('dd');
        for (let i = 0; i < dts.length; i++) {
            if (dds[i]) {
                const key = dts[i].innerText.trim();
                const value = dds[i].innerText.trim();
                data.main_attributes[key] = value;

                if (key.includes('Nutzfläche')) {
                    data.usable_space = value.replace(/[^0-9]/g, '');
                }
            }
        }
    }

    // Price
    const priceEl = document.querySelector('[class*="SpotlightAttributesPrice_value"]');
    if (priceEl) {
        data.price = priceEl.innerText.replace('CHF', '').replace('.–', '').trim();
    } else if (jsonLd.offers && jsonLd.offers.price) {
        data.price = jsonLd.offers.price;
    }
    data.price_type = "per_m2_year";

    // Provider
    const providerHeader = Array.from(document.querySelectorAll('h2')).find(h => h.innerText.includes('Anbieter'));
    if (providerHeader && providerHeader.parentElement) {
        const providerAddress = providerHeader.parentElement.querySelector('address');
        if (providerAddress) {
            data.provider = providerAddress.innerText.trim();
        }
    }

    // Images
    data.images = [];
    if (jsonLd.image) {
        if (Array.isArray(jsonLd.image)) {
            data.images = jsonLd.image;
        } else {
            data.images.push(jsonLd.image);
        }
    }
    const allImages = document.querySelectorAll('img');
    allImages.forEach(img => {
        const src = img.src || img.dataset.src;
        if (src && src.includes('cdn.immoscout24.ch') && !src.includes('icon') && !src.includes('logo')) {
            if (!data.images.includes(src)) {
                data.images.push(src);
            }
        }
    });
    data.images = [...new Set(data.images)];

    // Documents - flexible approach that works across site updates
    data.documents = [];
    const documentsHeader = Array.from(document.querySelectorAll('h2')).find(h => h.innerText.includes('Dokumente'));
    if (documentsHeader) {
        // Look in the next sibling, or parent's next sibling
        let container = documentsHeader.nextElementSibling;
        if (!container || !container.querySelector('a')) {
            container = documentsHeader.parentElement?.nextElementSibling;
        }

        if (container) {
            // Find all links containing .pdf or /document/ in href
            const docLinks = container.querySelectorAll('a[href*=".pdf"], a[href*="/document/"]');
            docLinks.forEach(link => {
                const url = link.href;

                // Try multiple ways to get the filename
                let filename = null;

                // Method 1: Look for span with text content (most common)
                const spans = link.querySelectorAll('span');
                for (const span of spans) {
                    const text = span.textContent.trim();
                    if (text && !text.includes('<!--') && text.length > 0) {
                        filename = text;
                        break;
                    }
                }

                // Method 2: Use link's direct text content
                if (!filename) {
                    const linkText = link.textContent.trim();
                    if (linkText && !linkText.includes('<!--')) {
                        filename = linkText;
                    }
                }

                // Method 3: Extract from URL as fallback
                if (!filename || filename.length === 0) {
                    const urlParts = url.split('/');
                    filename = urlParts[urlParts.length - 1];
                    // Remove hash if present
                    if (filename.includes('?')) {
                        filename = filename.split('?')[0];
                    }
                }

                // Only add if we have both URL and filename, and URL contains .pdf
                if (url && filename && url.match(/\.pdf($|\?)/i)) {
                    // Ensure filename has .pdf extension
                    if (!filename.toLowerCase().endsWith('.pdf')) {
                        filename = filename + '.pdf';
                    }
                    data.documents.push({ url, filename });
                }
            });
        }
    }

    return data;
}

function scrapeHomegate() {
    const data = {};

    // 1. Basic Info
    data.detail_url = window.location.href;
    const urlMatch = window.location.href.match(/\/(\d+)$/);
    data.listing_id = urlMatch ? urlMatch[1] : null;
    data.detailed = true;
    data.scraped_at = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Defaults
    data.column_id = "nicht_bewertet";
    data.position = 9999;
    data.rating = "";

    // 2. Title
    data.title = document.querySelector('h1')?.innerText?.trim() || document.title;

    // 3. Description
    // Homegate often uses "Beschreibung" h2
    const descHeader = Array.from(document.querySelectorAll('h2')).find(h => h.innerText.includes('Beschreibung'));
    if (descHeader && descHeader.nextElementSibling) {
        data.description = descHeader.nextElementSibling.innerText.trim();
    }

    // 4. Address
    const addressEl = document.querySelector('address');
    if (addressEl) {
        data.address = addressEl.innerText.replace(/\n/g, ', ').trim();
    }

    // 5. Price
    // Look for "Miete" label or similar structure
    // Based on example: class="SpotlightAttributesPrice_value_..."
    const priceEl = document.querySelector('[class*="SpotlightAttributesPrice_value"]');
    if (priceEl) {
        data.price = priceEl.innerText.replace('CHF', '').replace('.–', '').trim();
    }
    data.price_type = "per_m2_year"; // Assumption

    // 6. Usable Space
    const spaceEl = document.querySelector('[class*="SpotlightAttributesUsableSpace_value"]');
    if (spaceEl) {
        data.usable_space = spaceEl.innerText.replace(/[^0-9]/g, '');
    }

    // 7. Features
    data.features = [];
    const featuresHeader = Array.from(document.querySelectorAll('h2')).find(h => h.innerText.includes('Ausstattung') || h.innerText.includes('Eigenschaften'));
    if (featuresHeader && featuresHeader.nextElementSibling) {
        const listItems = featuresHeader.nextElementSibling.querySelectorAll('li p, li');
        listItems.forEach(li => {
            const text = li.innerText.trim();
            if (text) data.features.push(text);
        });
    }

    // 8. Provider
    const providerHeader = Array.from(document.querySelectorAll('h2')).find(h => h.innerText.includes('Anbieter'));
    if (providerHeader && providerHeader.parentElement) {
        const providerAddress = providerHeader.parentElement.querySelector('address');
        if (providerAddress) {
            data.provider = providerAddress.innerText.trim();
        }
    }

    // 9. Images
    data.images = [];
    // Homegate images often in a slider or gallery
    // Look for images with specific classes or containers
    const galleryImages = document.querySelectorAll('div[class*="ListingMediaGallery"] img');
    galleryImages.forEach(img => {
        const src = img.src || img.dataset.src;
        if (src && !data.images.includes(src)) {
            data.images.push(src);
        }
    });

    // Fallback: grab all large images
    if (data.images.length === 0) {
        const allImages = document.querySelectorAll('img');
        allImages.forEach(img => {
            const src = img.src || img.dataset.src;
            if (src && (src.includes('media2.homegate.ch') || src.includes('cdn.homegate.ch')) && !src.includes('icon') && !src.includes('logo')) {
                if (!data.images.includes(src)) {
                    data.images.push(src);
                }
            }
        });
    }
    data.images = [...new Set(data.images)];

    // 10. Main Attributes (General extraction if specific ones missed)
    data.main_attributes = {};
    if (data.usable_space) data.main_attributes['Nutzfläche'] = data.usable_space;
    // Try to find other attributes in dl/dt/dd if available (Homegate structure varies)

    // 11. Documents - flexible approach that works across site updates
    data.documents = [];
    const documentsHeader = Array.from(document.querySelectorAll('h2')).find(h => h.innerText.includes('Dokumente'));
    if (documentsHeader) {
        // Look in the next sibling, or parent's next sibling
        let container = documentsHeader.nextElementSibling;
        if (!container || !container.querySelector('a')) {
            container = documentsHeader.parentElement?.nextElementSibling;
        }

        if (container) {
            // Find all links containing .pdf or /document/ in href
            const docLinks = container.querySelectorAll('a[href*=".pdf"], a[href*="/document/"]');
            docLinks.forEach(link => {
                const url = link.href;

                // Try multiple ways to get the filename
                let filename = null;

                // Method 1: Look for span with text content (most common)
                const spans = link.querySelectorAll('span');
                for (const span of spans) {
                    const text = span.textContent.trim();
                    if (text && !text.includes('<!--') && text.length > 0) {
                        filename = text;
                        break;
                    }
                }

                // Method 2: Use link's direct text content
                if (!filename) {
                    const linkText = link.textContent.trim();
                    if (linkText && !linkText.includes('<!--')) {
                        filename = linkText;
                    }
                }

                // Method 3: Extract from URL as fallback
                if (!filename || filename.length === 0) {
                    const urlParts = url.split('/');
                    filename = urlParts[urlParts.length - 1];
                    // Remove hash if present
                    if (filename.includes('?')) {
                        filename = filename.split('?')[0];
                    }
                }

                // Only add if we have both URL and filename, and URL contains .pdf
                if (url && filename && url.match(/\.pdf($|\?)/i)) {
                    // Ensure filename has .pdf extension
                    if (!filename.toLowerCase().endsWith('.pdf')) {
                        filename = filename + '.pdf';
                    }
                    data.documents.push({ url, filename });
                }
            });
        }
    }

    return data;
}
