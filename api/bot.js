const express = require('express');
const axios = require('axios');

const app = express();

// Your NewsAPI Key built directly into the code
const API_KEY = '5b69e4d348ad436ca832910872c7d663';

function createSlug(title) {
    if (!title) return 'news-article';
    const cleanTitle = title.split(' - ')[0]; 
    return cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');    
}

// --------------------------------------------------------
// REALISTIC MOCK AD GENERATOR
// --------------------------------------------------------

// Ad Data Pools (Combining these creates 10,000+ unique ads)
const adBrands = ['CloudSync', 'AutoProtect', 'DevAcademy', 'HealthPlus', 'FinTrack', 'EcoHome', 'MarketPro', 'LuminaTech'];
const adHeadlines = [
    'Automate Your Workflow Today', 'Save 50% on Car Insurance', 'Learn to Code in 30 Days', 
    'The Ultimate CRM for Startups', 'Protect Your Online Privacy', 'Boost Your Credit Score Fast',
    'Get Healthy Delivered to Your Door', 'Upgrade Your Server Hosting'
];
const adDescriptions = [
    'Join over 2 million satisfied users. No credit card required.',
    'Limited time offer! Click here to claim your exclusive discount.',
    'Our award-winning platform makes it easier than ever to succeed.',
    'Stop wasting time and start saving money with our smart tools.',
    'Top-rated by industry experts. Find out why we are the best.'
];
const adCTAs = ['Learn More', 'Sign Up Now', 'Get Started', 'Download', 'Shop Now', 'Open'];
const adColors = ['#0d6efd', '#198754', '#dc3545', '#fd7e14', '#6f42c1']; // Blue, Green, Red, Orange, Purple

// Function to generate a random ad
function generateRandomAd(type) {
    const brand = adBrands[Math.floor(Math.random() * adBrands.length)];
    const headline = adHeadlines[Math.floor(Math.random() * adHeadlines.length)];
    const desc = adDescriptions[Math.floor(Math.random() * adDescriptions.length)];
    const cta = adCTAs[Math.floor(Math.random() * adCTAs.length)];
    const color = adColors[Math.floor(Math.random() * adColors.length)];
    
    // Generate a consistent but realistic placeholder image based on the brand
    const imgSeed = brand.length + headline.length;
    const imageUrl = `https://picsum.photos/seed/${imgSeed}/400/300`;

    // Google AdSense UI Overlay (AdChoices & Close button)
    const adChoicesUI = `
        <div class="mock-ad-choices">
            <span class="mock-ad-badge">Ad</span>
            <span class="mock-ad-close">×</span>
            <div class="mock-ad-triangle"></div>
        </div>
    `;

    if (type === 'banner') {
        // TOP BANNER (Horizontal Layout)
        return `
            <div class="mock-ad-container banner-ad mb-4 w-100">
                ${adChoicesUI}
                <div class="d-flex align-items-center h-100 p-2">
                    <img src="${imageUrl}" class="mock-ad-img-banner rounded" alt="${brand}">
                    <div class="mock-ad-text text-start mx-3 flex-grow-1">
                        <div class="mock-ad-brand">${brand}</div>
                        <h5 class="mock-ad-headline mb-1">${headline}</h5>
                        <p class="mock-ad-desc d-none d-md-block mb-0">${desc}</p>
                    </div>
                    <button class="btn btn-sm mock-ad-btn text-white px-4" style="background-color: ${color};">${cta}</button>
                </div>
            </div>
        `;
    } else {
        // RIGHT SIDEBAR (Vertical/Skyscraper Layout)
        return `
            <div class="mock-ad-container sidebar-ad sticky-top" style="top: 20px;">
                ${adChoicesUI}
                <div class="p-3 d-flex flex-column h-100 text-center">
                    <div class="mock-ad-brand mb-2">${brand}</div>
                    <img src="${imageUrl}" class="mock-ad-img-sidebar rounded mb-3 w-100" alt="${brand}">
                    <h5 class="mock-ad-headline mb-2">${headline}</h5>
                    <p class="mock-ad-desc flex-grow-1 text-muted">${desc}</p>
                    <button class="btn w-100 mock-ad-btn text-white mt-auto" style="background-color: ${color};">${cta}</button>
                </div>
            </div>
        `;
    }
}

// CSS to make it look exactly like AdSense
const adStyles = `
    <style>
        .mock-ad-container {
            background-color: #ffffff;
            border: 1px solid #e0e0e0;
            border-radius: 2px;
            position: relative;
            overflow: hidden;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            font-family: Arial, sans-serif;
            text-decoration: none;
            color: #333;
        }
        .mock-ad-container:hover { border-color: #c0c0c0; cursor: pointer; }
        
        /* Banner specific sizing */
        .banner-ad { height: 90px; }
        .mock-ad-img-banner { width: 74px; height: 74px; object-fit: cover; }
        
        /* Sidebar specific sizing */
        .sidebar-ad { min-height: 600px; }
        .mock-ad-img-sidebar { height: 250px; object-fit: cover; }

        /* Typography */
        .mock-ad-brand { font-size: 11px; color: #777; text-transform: uppercase; letter-spacing: 0.5px; }
        .mock-ad-headline { font-size: 16px; font-weight: bold; color: #1a0dab; margin: 0; line-height: 1.2; }
        .sidebar-ad .mock-ad-headline { font-size: 20px; }
        .mock-ad-desc { font-size: 13px; color: #4d5156; }
        .mock-ad-btn { font-weight: bold; text-transform: uppercase; border-radius: 3px; font-size: 13px; border: none; }

        /* AdSense UI Overlays */
        .mock-ad-choices { position: absolute; top: 0; right: 0; display: flex; align-items: center; z-index: 10; background: rgba(255,255,255,0.9); padding: 0 0 2px 4px; border-bottom-left-radius: 4px; }
        .mock-ad-badge { font-size: 10px; color: #757575; margin-right: 4px; background: #f1f3f4; padding: 1px 4px; border-radius: 2px; border: 1px solid #dadce0;}
        .mock-ad-close { font-size: 14px; color: #757575; line-height: 1; cursor: pointer; padding: 0 4px; }
        .mock-ad-close:hover { color: #000; }
        .mock-ad-triangle { width: 0; height: 0; border-top: 12px solid #00a1f1; border-left: 12px solid transparent; position: absolute; top: 0; right: 0; opacity: 0.8; }
    </style>
`;

// --------------------------------------------------------
// 1. MAIN ROUTE (Home Page & Search)
// --------------------------------------------------------
app.get('/', async (req, res) => {
    const searchQuery = req.query.q || '';
    let apiUrl = '';
    let pageTitle = '';

    if (searchQuery) {
        apiUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(searchQuery)}&pageSize=10&apiKey=${API_KEY}`;
        pageTitle = `Search Results for "${searchQuery}"`;
    } else {
        apiUrl = `https://newsapi.org/v2/top-headlines?country=us&pageSize=10&apiKey=${API_KEY}`;
        pageTitle = 'Top 10 Headlines';
    }

    try {
        const response = await axios.get(apiUrl);
        const articles = response.data.articles.filter(article => article.title !== '[Removed]');
        res.send(generateIndexHTML(articles, pageTitle, searchQuery));
    } catch (error) {
        const errorMsg = "Error fetching news. Please try again later.";
        res.send(generateIndexHTML([], errorMsg, searchQuery));
    }
});

// --------------------------------------------------------
// 2. SINGLE ARTICLE BLOG PAGE
// --------------------------------------------------------
app.get('/article/:slug', async (req, res) => {
    const slug = req.params.slug;
    const searchWords = slug.replace(/-/g, ' ');
    const apiUrl = `https://newsapi.org/v2/everything?qInTitle=${encodeURIComponent(searchWords)}&pageSize=1&apiKey=${API_KEY}`;

    try {
        const response = await axios.get(apiUrl);
        const article = response.data.articles[0]; 
        
        if (!article || article.title === '[Removed]') {
            return res.status(404).send(generateErrorHTML(`Article not found.`));
        }
        res.send(generateArticleHTML(article));
    } catch (error) {
        res.status(500).send(generateErrorHTML('Error fetching the article details.'));
    }
});

// --------------------------------------------------------
// HTML GENERATORS
// --------------------------------------------------------
function generateIndexHTML(articles, title, searchQuery) {
    let articlesHTML = '';

    if (articles.length > 0) {
        articlesHTML = articles.map(article => {
            const slug = createSlug(article.title);
            const articleUrl = `/article/${slug}`;
            
            return `
            <div class="col-md-6 mb-4">
                <div class="card h-100 shadow-sm">
                    <a href="${articleUrl}">
                        <img src="${article.urlToImage || 'https://via.placeholder.com/400x200?text=No+Image'}" 
                             class="card-img-top" alt="${article.title}" style="height: 200px; object-fit: cover;">
                    </a>
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title">
                            <a href="${articleUrl}" class="text-dark text-decoration-none">${article.title}</a>
                        </h5>
                        <p class="card-text text-muted small">
                            By ${article.author || 'Unknown'} | ${new Date(article.publishedAt).toLocaleDateString()}
                        </p>
                        <a href="${articleUrl}" class="btn btn-outline-primary mt-auto">Read Article</a>
                    </div>
                </div>
            </div>
            `;
        }).join('');
    } else {
        articlesHTML = `<div class="col-12"><div class="alert alert-warning">No articles found.</div></div>`;
    }

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Daily News Blog</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        ${adStyles}
    </head>
    <body class="bg-light">
        <nav class="navbar navbar-expand-lg navbar-dark bg-dark mb-4">
            <div class="container">
                <a class="navbar-brand" href="/">📰 Daily News Blog</a>
                <form class="d-flex" action="/" method="GET">
                    <input class="form-control me-2" type="search" name="q" placeholder="Search news..." value="${searchQuery}" required>
                    <button class="btn btn-outline-light" type="submit">Search</button>
                </form>
            </div>
        </nav>
        
        <div class="container">
            <!-- TOP BANNER AD (Generated Dynamically) -->
            ${generateRandomAd('banner')}

            <h2 class="mb-4">${title}</h2>
            
            <div class="row">
                <div class="col-lg-8">
                    <div class="row">
                        ${articlesHTML}
                    </div>
                </div>

                <aside class="col-lg-4 d-none d-lg-block">
                    <!-- RIGHT SIDEBAR AD (Generated Dynamically) -->
                    ${generateRandomAd('sidebar')}
                </aside>
            </div>
        </div>
    </body>
    </html>
    `;
}

function generateArticleHTML(article) {
    const pubDate = new Date(article.publishedAt).toLocaleDateString();
    const safeTitle = article.title ? article.title.replace(/"/g, '&quot;') : 'News Article';
    const safeImage = article.urlToImage || 'https://via.placeholder.com/800x400?text=No+Image';

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${safeTitle} - Daily News Blog</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        ${adStyles}
    </head>
    <body class="bg-light">
        <nav class="navbar navbar-expand-lg navbar-dark bg-dark mb-4">
            <div class="container">
                <a class="navbar-brand" href="/">📰 Daily News Blog</a>
                <a class="btn btn-outline-light btn-sm ms-auto" href="/">← Back to Home</a>
            </div>
        </nav>
        
        <div class="container mb-5">
            <!-- TOP BANNER AD (Generated Dynamically) -->
            ${generateRandomAd('banner')}

            <div class="row">
                <div class="col-lg-8">
                    <article class="bg-white p-4 p-md-5 rounded shadow-sm">
                        <h1 class="mb-3">${article.title}</h1>
                        <p class="text-muted mb-4">
                            <strong>By ${article.author || 'Unknown'}</strong> | ${pubDate} 
                        </p>
                        <img src="${safeImage}" class="img-fluid rounded mb-4 w-100" style="max-height: 450px; object-fit: cover;">
                        <div class="fs-5 mb-4" style="line-height: 1.8;">
                            <p class="lead fw-bold">${article.description || ''}</p>
                            <p>${article.content ? article.content.replace(/\[\+\d+ chars\]/, '') : 'Content not available.'}</p>
                        </div>
                        <a href="${article.url}" target="_blank" class="btn btn-dark btn-lg w-100">Read on ${article.source.name}</a>
                    </article>
                </div>

                <aside class="col-lg-4 mt-4 mt-lg-0">
                    <!-- RIGHT SIDEBAR AD (Generated Dynamically) -->
                    ${generateRandomAd('sidebar')}
                </aside>
            </div>
        </div>
    </body>
    </html>
    `;
}

function generateErrorHTML(message) {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <title>Error - Daily News Blog</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    </head>
    <body class="bg-light text-center pt-5">
        <div class="container mt-5">
            <h1 class="text-danger">Oops!</h1>
            <p class="lead">${message}</p>
            <a href="/" class="btn btn-primary">Go Back Home</a>
        </div>
    </body>
    </html>
    `;
}

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

module.exports = app;
