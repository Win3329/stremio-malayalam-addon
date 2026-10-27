const express = require('express');
const cors = require('cors');
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
  version: '1.1.0',
  name: 'Malayalam Direct MultiStream',
  description: 'Unlimited Malayalam movies with ratings, clean posters, and 11Tamil/HDHub streams.',
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
      name: 'Popular Malayalam Movies (2020+ Rated)',
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
  const today = new Date().toISOString().split('T')[0]; // Current date cap to avoid future 2027 movies

  try {
    let url = '';

    if (fullPath.includes('classics')) {
      url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&with_original_language=ml&primary_release_date.lte=2012-12-31&sort_by=popularity.desc&page=${page}`;
    } else if (fullPath.includes('popular')) {
      url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&with_original_language=ml&primary_release_date.gte=2020-01-01&primary_release_date.lte=${today}&sort_by=vote_average.desc&vote_count.gte=10&page=${page}`;
    } else {
      // Recently Added: Capped at today's date to filter out 2027 unreleased announcements
      url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&with_original_language=ml&primary_release_date.gte=2020-01-01&primary_release_date.lte=${today}&sort_by=primary_release_date.desc&page=${page}`;
    }

    const response = await axios.get(url, { timeout: 6000 });
    const results = response.data.results || [];

    const formattedMetas = results.map(item => {
      const releaseDate = item.release_date ? new Date(item.release_date) : null;
      const releaseYear = releaseDate ? releaseDate.getFullYear().toString() : '2026';
      
      const rawPoster = item.poster_path 
        ? `https://image.tmdb.org/t/p/w500${item.poster_path}` 
        : '';

      return {
        id: `tmdb:${item.id}`,
        type: 'movie',
        name: item.title,
        releaseInfo: releaseYear,
        poster: rawPoster
      };
    });

    return res.json({ metas: formattedMetas });
  } catch (err) {
    console.error('TMDB Fetch Error:', err.message);
    return res.json({ metas: [] });
  }
});

// --- META HANDLER (Includes Rating & Cast) ---
app.use('/meta/movie/:id', async (req, res) => {
  const rawId = req.params.id || '';
  const tmdbId = rawId.replace('.json', '').replace('tmdb:', '');

  try {
    const tmdbRes = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=credits`);
    const movie = tmdbRes.data;

    // Extract top 5 cast members' names
    const castMembers = movie.credits && movie.credits.cast 
      ? movie.credits.cast.slice(0, 5).map(actor => actor.name) 
      : [];

    res.json({
      meta: {
        id: `tmdb:${tmdbId}`,
        type: 'movie',
        name: movie.title,
        poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : '',
        background: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : '',
        description: movie.overview,
        releaseInfo: movie.release_date ? movie.release_date.split('-')[0] : '',
        imdbRating: movie.vote_average ? movie.vote_average.toFixed(1) : undefined,
        cast: castMembers
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

// --- STREAM HANDLER (Includes HDHub & 11Tamil / 1TamilMV Search) ---
app.use('/stream/movie/:id', async (req, res) => {
  const rawId = req.params.id || '';
  const movieId = rawId.replace('.json', '');
  const streams = [];
  let movieTitle = movieId;

  try {
    let imdbId = movieId;

    if (movieId.startsWith('tmdb:')) {
      const tmdbId = movieId.replace('tmdb:', '');
      const tmdbRes = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}`);
      if (tmdbRes.data) {
        if (tmdbRes.data.imdb_id) {
          imdbId = tmdbRes.data.imdb_id;
        }
        if (tmdbRes.data.title) {
          movieTitle = tmdbRes.data.title;
        }
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

  // Fallback / Direct Search Links for HDHub4u and 11Tamil (1TamilMV)
  if (streams.length === 0) {
    streams.push({
      name: 'HDHub Search',
      title: 'Search Title on HDHub4u',
      externalUrl: `https://hdhub4u.ms/?s=${encodeURIComponent(movieTitle)}`
    });
  }

  // Always add an option to check and search directly on 11Tamil / 1TamilMV
  streams.push({
    name: '11Tamil / TamilMV',
    title: `Check Availability on 11Tamil (1TamilMV)`,
    externalUrl: `https://www.1tamilmv.com.in/?s=${encodeURIComponent(movieTitle)}`
  });

  res.json({ streams });
});

app.listen(PORT, () => {
  console.log(`Malayalam Addon running on ${HOST}`);
  console.log(`Manifest URL: ${HOST}/manifest.json`);
});
