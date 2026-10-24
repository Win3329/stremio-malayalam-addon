const express = require('express');
const cors = require('cors');
const sharp = require('sharp');
const axios = require('axios');

const app = express();

// Enable CORS for all origins (Required by Stremio)
app.use(cors());

// Terminal logging for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const PORT = process.env.PORT || 7000;
const HOST = process.env.RENDER_EXTERNAL_URL || process.env.ADDON_HOST || `http://localhost:${PORT}`;

const TMDB_KEY = '7b3df6ca1409f8b05ce8f12f6568becc';

// --- STREMIO MANIFEST ---
const manifest = {
  id: 'org.malayalam.multisource.v1',
  version: '1.0.0',
  name: 'Malayalam Direct MultiStream',
  description: 'Unlimited Malayalam movies with dynamic CAM/HD badges and free direct streams.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  catalogs: [
    {
      type: 'movie',
      id: 'malayalam_recently_added',
      name: 'Recently Added Malayalam',
      extra: [{ name: 'skip' }]
    },
    {
      type: 'movie',
      id: 'malayalam_popular',
      name: 'Popular Malayalam Movies',
      extra: [{ name: 'skip' }]
    },
    {
      type: 'movie',
      id: 'malayalam_classics',
      name: 'Classic Malayalam Movies',
      extra: [{ name: 'skip' }]
    }
  ]
};

// --- DYNAMIC POSTER BADGE ROUTE ---
app.get('/poster', async (req, res) => {
  const { quality, originalPoster } = req.query;

  try {
    let imageBuffer;
    if (originalPoster && originalPoster.startsWith('http')) {
      const resp = await axios.get(originalPoster, { 
        responseType: 'arraybuffer',
        timeout: 3000 
      });
      imageBuffer = Buffer.from(resp.data);
    } else {
      imageBuffer = await sharp({
        create: { width: 300, height: 450, channels: 3, background: { r: 35, g: 35, b: 35 } }
      }).png().toBuffer();
    }

    const badgeText = quality ? quality.toUpperCase() : 'HD MALAYALAM';
    const isCam = badgeText === 'CAM';

    const badgeSvg = `
      <svg width="300" height="450">
        <rect x="8" y="8" width="${isCam ? 60 : 115}" height="24" rx="3" ry="3" fill="#e50914" />
        <text x="${isCam ? 38 : 65}" y="24" font-family="sans-serif" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">
          ${badgeText}
        </text>
      </svg>
    `;

    const processedImage = await sharp(imageBuffer)
      .resize(300, 450, { fit: 'cover' })
      .composite([{ input: Buffer.from(badgeSvg), top: 0, left: 0 }])
      .jpeg()
      .toBuffer();

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(processedImage);
  } catch (err) {
    if (originalPoster && originalPoster.startsWith('http')) {
      return res.redirect(originalPoster);
    }
    return res.status(404).send('Poster error');
  }
});

// --- MANIFEST ENDPOINT ---
app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

// --- UNLIMITED PAGINATED CATALOG HANDLER ---
app.use('/catalog/movie/:id', async (req, res) => {
  const fullPath = req.params.id || '';
  
  let skip = 0;
  const skipMatch = req.url.match(/skip=(\d+)/);
  if (skipMatch) {
    skip = parseInt(skipMatch[1], 10);
  }

  const page = Math.floor(skip / 20) + 1;

  try {
    let url = '';

    if (fullPath.includes('classics')) {
      url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&with_original_language=ml&primary_release_date.lte=2012-12-31&sort_by=popularity.desc&page=${page}`;
    } else if (fullPath.includes('popular')) {
      url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&with_original_language=ml&sort_by=popularity.desc&page=${page}`;
    } else {
      url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&with_original_language=ml&sort_by=primary_release_date.desc&vote_count.gte=1&page=${page}`;
    }

    const response = await axios.get(url, { timeout: 6000 });
    const results = response.data.results || [];

    const now = new Date();

    const formattedMetas = results.map(item => {
      const releaseDate = item.release_date ? new Date(item.release_date) : null;
      const releaseYear = releaseDate ? releaseDate.getFullYear().toString() : '2026';
      
      let quality = 'HD Malayalam';
      if (releaseDate) {
        const diffDays = Math.floor((now - releaseDate) / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays <= 45) {
          quality = 'CAM';
        }
      }

      const rawPoster = item.poster_path 
        ? `https://image.tmdb.org/t/p/w500${item.poster_path}` 
        : '';

      return {
        id: `tmdb:${item.id}`,
        type: 'movie',
        name: item.title,
        releaseInfo: releaseYear,
        poster: `${HOST}/poster?quality=${encodeURIComponent(quality)}&originalPoster=${encodeURIComponent(rawPoster)}`
      };
    });

    return res.json({ metas: formattedMetas });
  } catch (err) {
    console.error('TMDB Fetch Error:', err.message);
    return res.json({ metas: [] });
  }
});

// --- META HANDLER ---
app.use('/meta/movie/:id', async (req, res) => {
  const rawId = req.params.id || '';
  const tmdbId = rawId.replace('.json', '').replace('tmdb:', '');

  try {
    const tmdbRes = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}`);
    const movie = tmdbRes.data;

    res.json({
      meta: {
        id: `tmdb:${tmdbId}`,
        type: 'movie',
        name: movie.title,
        poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : '',
        background: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : '',
        description: movie.overview,
        releaseInfo: movie.release_date ? movie.release_date.split('-')[0] : ''
      }
    });
  } catch (err) {
    res.json({
      meta: {
        id: `tmdb:${tmdbId}`,
        type: 'movie',
        name: 'Malayalam Movie',
        description: 'Malayalam feature film.'
      }
    });
  }
});

// --- SAFE MULTI-SOURCE STREAM HANDLER ---
app.use('/stream/movie/:id', async (req, res) => {
  const rawId = req.params.id || '';
  const movieId = rawId.replace('.json', '');
  const streams = [];

  try {
    let imdbId = movieId;

    if (movieId.startsWith('tmdb:')) {
      const tmdbId = movieId.replace('tmdb:', '');
      const tmdbRes = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}`);
      if (tmdbRes.data && tmdbRes.data.imdb_id) {
        imdbId = tmdbRes.data.imdb_id;
      }
    }

    // Scrape HDHub direct stream scraper safely
    try {
      const hdhubUrl = `https://hdhub.thevolecitor.qzz.io/eyJ0b3Jib3giOiJ1bnNldCIsInF1YWxpdGllcyI6IjIxNjBwLDEwODBwLDcyMHAiLCJzb3J0IjoiZGVzYyJ9/stream/movie/${imdbId}.json`;
      const hdhubRes = await axios.get(hdhubUrl, { timeout: 5000 });
      if (hdhubRes.data && hdhubRes.data.streams && hdhubRes.data.streams.length > 0) {
        streams.push(...hdhubRes.data.streams);
      }
    } catch (e) {
      console.log('HDHub scraper query skipped/timed out.');
    }

  } catch (err) {
    console.error('Stream Handler Error:', err.message);
  }

  // Fallback direct web search stream if no direct streams found
  if (streams.length === 0) {
    streams.push({
      name: 'HDHub Search',
      title: 'Search Title on HDHub4u',
      externalUrl: `https://hdhub4u.ms/?s=${encodeURIComponent(movieId)}`
    });
  }

  res.json({ streams });
});

app.listen(PORT, () => {
  console.log(`Malayalam Addon running on ${HOST}`);
  console.log(`Manifest URL: ${HOST}/manifest.json`);
});
