const express = require('express');
const axios = require('axios');

const app = express();

// Your NewsAPI Key
const API_KEY = '5b69e4d348ad436ca832910872c7d663';

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
        const errorMsg = error.response && error.response.status === 426 
            ? "NewsAPI blocks free keys on Vercel. You must upgrade your NewsAPI plan or run on localhost." 
            : "Error fetching news. Please try again later.";
        res.send(generateIndexHTML([], errorMsg, searchQuery));
    }
});

// --------------------------------------------------------
// 2. SINGLE ARTICLE BLOG PAGE (SEO Friendly Route)
// --------------------------------------------------------
app.get('/article/:title', async (req, res) => {
    const articleTitle = req.params.title;
    
    // Fetch the specific article by searching for its exact title
    const apiUrl = `https://newsapi.org/v2/everything?qInTitle="${encodeURIComponent(articleTitle)}"&pageSize=1&apiKey=${API_KEY}`;

    try {
        const response = await axios.get(apiUrl);
        const article = response.data.articles[0]; // Get the first match
        
        if (!article || article.title === '[Removed]') {
            return res.status(404).send(generateErrorHTML('Article not found.'));
        }
        
        res.send(generateArticleHTML(article));
    } catch (error) {
        res.status(500).send(generateErrorHTML('Error fetching the article details.'));
    }
});

// --------------------------------------------------------
// HTML GENERATOR: Home Page
// --------------------------------------------------------
function generateIndexHTML(articles, title, searchQuery) {
    let articlesHTML = '';

    if (articles.length > 0) {
        articlesHTML = articles.map(article => {
            // Create a clean URL slug for the article
            const articleUrl = `/article/${encodeURIComponent(article.title)}`;
            
            return `
            <div class="col-md-6 col-lg-4 mb-4">
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
                        <p class="card-text">${article.description ? article.description.substring(0, 100) + '...' : 'No description available.'}</p>
                        <a href="${articleUrl}" class="btn btn-primary mt-auto">Read Article</a>
                    </div>
                </div>
            </div>
            `;
        }).join('');
    } else {
        articlesHTML = `<div class="col-12"><div class="alert alert-warning">${title === 'Top 10 Headlines' ? 'No articles found.' : title}</div></div>`;
    }

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Daily News Blog</title>
        <meta name="description" content="Catch up on the top 10 latest news headlines and search for your favorite topics.">
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
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
            <h2 class="mb-4">${title}</h2>
            <div class="row">
                ${articlesHTML}
            </div>
        </div>
    </body>
    </html>
    `;
}

// --------------------------------------------------------
// HTML GENERATOR: Single Article Page (SEO Optimized)
// --------------------------------------------------------
function generateArticleHTML(article) {
    const pubDate = new Date(article.publishedAt).toLocaleDateString();
    
    // Fallback strings to prevent errors if API returns null
    const safeTitle = article.title ? article.title.replace(/"/g, '&quot;') : 'News Article';
    const safeDesc = article.description ? article.description.replace(/"/g, '&quot;') : 'Read the latest news on our blog.';
    const safeImage = article.urlToImage || 'https://via.placeholder.com/800x400?text=No+Image';

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        
        <!-- SEO Meta Tags -->
        <title>${safeTitle} - Daily News Blog</title>
        <meta name="description" content="${safeDesc}">
        <meta name="author" content="${article.author || 'Unknown'}">
        
        <!-- Open Graph / Facebook -->
        <meta property="og:type" content="article">
        <meta property="og:title" content="${safeTitle}">
        <meta property="og:description" content="${safeDesc}">
        <meta property="og:image" content="${safeImage}">
        
        <!-- Twitter Cards -->
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:title" content="${safeTitle}">
        <meta name="twitter:description" content="${safeDesc}">
        <meta name="twitter:image" content="${safeImage}">

        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    </head>
    <body class="bg-light">
        <!-- Navbar -->
        <nav class="navbar navbar-expand-lg navbar-dark bg-dark mb-4">
            <div class="container">
                <a class="navbar-brand" href="/">📰 Daily News Blog</a>
                <a class="btn btn-outline-light btn-sm ms-auto" href="/">← Back to Home</a>
            </div>
        </nav>

        <!-- Article Content -->
        <div class="container mb-5">
            <div class="row justify-content-center">
                <div class="col-lg-8">
                    <nav aria-label="breadcrumb">
                      <ol class="breadcrumb">
                        <li class="breadcrumb-item"><a href="/">Home</a></li>
                        <li class="breadcrumb-item active" aria-current="page">Article</li>
                      </ol>
                    </nav>

                    <article class="bg-white p-4 p-md-5 rounded shadow-sm">
                        <h1 class="mb-3">${article.title}</h1>
                        <p class="text-muted mb-4">
                            <strong>By ${article.author || 'Unknown'}</strong> | Published on ${pubDate} 
                            | Source: <span class="badge bg-secondary">${article.source.name}</span>
                        </p>
                        
                        <img src="${safeImage}" class="img-fluid rounded mb-4 w-100" alt="${safeTitle}" style="max-height: 450px; object-fit: cover;">
                        
                        <div class="fs-5 mb-4" style="line-height: 1.8;">
                            <p class="lead fw-bold">${article.description || ''}</p>
                            <p>${article.content ? article.content.replace(/\[\+\d+ chars\]/, '') : 'Content not available.'}</p>
                        </div>
                        
                        <hr>
                        <div class="mt-4 text-center">
                            <p class="text-muted small">NewsAPI limits free tier full-article content length.</p>
                            <a href="${article.url}" target="_blank" rel="noopener noreferrer" class="btn btn-dark btn-lg">
                                Read the original post on ${article.source.name}
                            </a>
                        </div>
                    </article>
                </div>
            </div>
        </div>
    </body>
    </html>
    `;
}

// --------------------------------------------------------
// HTML GENERATOR: Error Page
// --------------------------------------------------------
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

// Export the App for Vercel
module.exports = app;
