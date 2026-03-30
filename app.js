// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "REEMPLAZA_CON_TU_NUEVA_CLAVE_RESTRINGIDA",
  authDomain: "adventist-player.firebaseapp.com",
  projectId: "adventist-player",
  storageBucket: "adventist-player.firebasestorage.app",
  messagingSenderId: "968824214640",
  appId: "1:968824214640:web:592e9180145cc38f6550b5",
  measurementId: "G-9Z6TV73ZKX"
};

// Initialize Firebase (Using Compat SDK)
firebase.initializeApp(firebaseConfig);
firebase.analytics();

const API_URL = 'https://samurc.github.io/adventist-radio-api/web.json';

let allStations = [];
let favorites = JSON.parse(localStorage.getItem('adventist-favs')) || [];
let currentStation = null;
let hls = null;
let selectedLanguage = localStorage.getItem('adventist-last-lang') || 'Todos';
let isShuffle = localStorage.getItem('adventist-shuffle') === 'true';

document.addEventListener('DOMContentLoaded', () => {
    const mainContent = document.getElementById('main-content');
    const header = document.getElementById('header');
    
    // Grids
    const allStationsGrid = document.getElementById('all-stations-grid');
    const favoritesGrid = document.getElementById('favorites-grid');
    const favoritesSection = document.getElementById('favorites-section');
    const languageFilters = document.getElementById('language-filters');

    // UI Elements
    const searchInput = document.getElementById('station-search');
    const audio = document.getElementById('audio-player');
    const heroTitle = document.getElementById('hero-title');
    const heroSection = document.getElementById('hero-section');
    const heroPlayBtn = document.getElementById('hero-play-btn');
    const heroFavBtn = document.getElementById('hero-fav-btn');

    const currentTitle = document.getElementById('current-title');
    const currentArtist = document.getElementById('current-artist');
    const currentCover = document.getElementById('current-cover');
    const playerFavBtn = document.getElementById('player-fav-btn');
    const playToggle = document.getElementById('main-play-toggle');
    const shuffleBtn = document.getElementById('shuffle-btn');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const progressFill = document.getElementById('progress-fill');

    // Sidebar Items
    const navReport = document.getElementById('nav-report-sidebar');
    const navHome = document.getElementById('nav-home');

    // --- Data Fetch ---
    async function init() {
        try {
            const response = await fetch(API_URL);
            const data = await response.json();
            allStations = data.estaciones;
            
            renderLanguageFilters();
            renderAll();
            updateShuffleUI();

            // Restore Last Played or Use First Station
            const lastPlayedId = localStorage.getItem('adventist-last-played');
            let initialStation = allStations[0];
            
            if (lastPlayedId) {
                const found = allStations.find(s => s.id == lastPlayedId);
                if (found) initialStation = found;
            }

            if (initialStation) {
                updateHero(initialStation);
                updatePlayerUI(initialStation);
            }
        } catch (error) {
            console.error('Error fetching stations:', error);
            trendingGrid.innerHTML = '<p class="u-text-muted">Error al cargar las estaciones.</p>';
        }
    }

    // --- Render Logic ---
    function renderAll() {
        // Filter stations based on search and language
        const query = searchInput.value.toLowerCase();
        const filtered = allStations.filter(s => {
            const matchesQuery = !query || 
                s.nombre.toLowerCase().includes(query) || 
                s.pais.toLowerCase().includes(query) ||
                s.region.toLowerCase().includes(query);
            const matchesLang = selectedLanguage === 'Todos' || s.idioma === selectedLanguage;
            return matchesQuery && matchesLang;
        });

        const allStationsTitle = document.getElementById('all-stations-title');
        allStationsTitle.innerText = query ? 'Resultados de búsqueda' : 'Todas las Radios';

        renderGrid(allStationsGrid, filtered);
        updateFavoritesUI();
    }

    function getFilteredStations() {
        const query = searchInput.value.toLowerCase();
        return allStations.filter(s => {
            const matchesQuery = !query || 
                s.nombre.toLowerCase().includes(query) || 
                s.pais.toLowerCase().includes(query) ||
                s.region.toLowerCase().includes(query);
            const matchesLang = selectedLanguage === 'Todos' || s.idioma === selectedLanguage;
            return matchesQuery && matchesLang;
        });
    }

    function renderLanguageFilters() {
        const languages = ['Todos', ...new Set(allStations.map(s => s.idioma))];
        languageFilters.innerHTML = languages.map(lang => `
            <button class="c-filter-chip ${selectedLanguage === lang ? 'is-active' : ''}" data-lang="${lang}">
                ${lang}
            </button>
        `).join('');
    }

    function renderGrid(container, stations) {
        if (!container) return;
        container.innerHTML = stations.map(station => {
            const isFav = favorites.includes(station.id);
            return `
                <div class="c-card" data-id="${station.id}" role="link" aria-label="Escuchar ${station.nombre} de ${station.pais}">
                    <div class="c-card__image" style="background-image: url('${station.imgMobile}')" role="img" aria-label="Logo de ${station.nombre}"></div>
                    <div class="c-card__play-button">
                        <ion-icon name="play" style="font-size: 24px; color: white;"></ion-icon>
                    </div>
                    <button class="c-card__fav-button ${isFav ? 'is-favorite' : ''}" data-id="${station.id}">
                        <ion-icon name="${isFav ? 'heart' : 'heart-outline'}"></ion-icon>
                    </button>
                    <h3 class="c-card__title">${station.nombre}</h3>
                    <p class="c-card__description">${station.pais} ${station.dial}</p>
                </div>
            `;
        }).join('');
    }

    function updateFavoritesUI() {
        const favStations = allStations.filter(s => favorites.includes(s.id));
        if (favStations.length > 0) {
            favoritesSection.style.display = 'block';
            renderGrid(favoritesGrid, favStations);
        } else {
            favoritesSection.style.display = 'none';
        }
    }

    function updateHero(station) {
        heroTitle.innerText = station.nombre;
        heroSection.style.backgroundImage = `url('${station.imgMobile}')`;
        heroPlayBtn.onclick = () => playStation(station);
        
        const isFav = favorites.includes(station.id);
        heroFavBtn.innerHTML = `<ion-icon name="${isFav ? 'heart' : 'heart-outline'}"></ion-icon>`;
        heroFavBtn.classList.toggle('is-favorite', isFav);
        heroFavBtn.onclick = (e) => {
            e.stopPropagation();
            toggleFavorite(station.id);
        };
    }

    // --- Favorites Logic ---
    function toggleFavorite(id) {
        id = parseInt(id);
        const index = favorites.indexOf(id);
        if (index > -1) {
            favorites.splice(index, 1);
        } else {
            favorites.push(id);
        }
        
        localStorage.setItem('adventist-favs', JSON.stringify(favorites));
        
        // Sync UI
        renderAll();
        if (currentStation && currentStation.id === id) {
            updatePlayerFavUI();
        }
        if (id === parseInt(heroFavBtn.closest('section')?.dataset?.id) || true) {
            // simpler: re-update hero if it's the same station
            const currentHeroStation = allStations.find(s => s.nombre === heroTitle.innerText);
            if (currentHeroStation) updateHero(currentHeroStation);
        }
    }

    function updatePlayerFavUI() {
        if (!currentStation) return;
        const isFav = favorites.includes(currentStation.id);
        playerFavBtn.innerHTML = `<ion-icon name="${isFav ? 'heart' : 'heart-outline'}"></ion-icon>`;
        playerFavBtn.classList.toggle('is-favorite', isFav);
    }

    function updatePlayerUI(station) {
        currentStation = station;
        currentTitle.innerText = station.nombre;
        currentArtist.innerText = `${station.pais} | ${station.dial}`;
        currentCover.style.backgroundImage = `url('${station.imgMobile}')`;
        updatePlayerFavUI();
        
        // Highlight active card if it's rendered
        document.querySelectorAll('.c-card').forEach(card => {
            card.classList.toggle('is-playing', card.dataset.id == station.id);
        });
    }

    async function fetchTemporalStreamUrl(station) {
        if (!station.temporal || !station.proveedor || !station.nodo || !station.pwd) return null;
        
        try {
            const url = `${station.proveedor}?x=${station.nodo}&password=${station.pwd}`;
            const response = await fetch(url);
            if (!response.ok) return null;
            
            const data = await response.json();
            return data.https?.apple || data.http?.apple || null;
        } catch (error) {
            console.error('Error fetching temporal URL:', error);
            return null;
        }
    }

    // --- Playback Logic ---
    async function playStation(station, isRetry = false) {
        // Save State
        localStorage.setItem('adventist-last-played', station.id);
        
        // UI Update
        updatePlayerUI(station);
        updateHero(station);

        const streamUrl = station.medialiveUrl;

        const handleError = async () => {
            if (station.temporal && !isRetry) {
                console.log('Stream failed. Attempting temporal resolution...');
                const newUrl = await fetchTemporalStreamUrl(station);
                if (newUrl) {
                    station.medialiveUrl = newUrl;
                    playStation(station, true);
                }
            }
        };

        if (hls) {
            hls.destroy();
            hls = null;
        }

        if (streamUrl.endsWith('.m3u8')) {
            if (Hls.isSupported()) {
                hls = new Hls();
                hls.loadSource(streamUrl);
                hls.attachMedia(audio);
                hls.on(Hls.Events.MANIFEST_PARSED, () => audio.play());
                hls.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) handleError();
                });
            } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
                audio.src = streamUrl;
                audio.onerror = handleError;
                audio.play();
            }
        } else {
            audio.src = streamUrl;
            audio.onerror = handleError;
            audio.play();
        }

        updatePlayToggleIcon(true);
    }

    function playNext() {
        const list = getFilteredStations();
        if (list.length <= 1) return;
        
        let nextIndex;
        if (isShuffle) {
            do {
                nextIndex = Math.floor(Math.random() * list.length);
            } while (currentStation && list[nextIndex].id === currentStation.id && list.length > 1);
        } else {
            const currentIndex = list.findIndex(s => s.id === currentStation?.id);
            nextIndex = (currentIndex + 1) % list.length;
        }
        
        playStation(list[nextIndex]);
    }

    function playPrev() {
        const list = getFilteredStations();
        if (list.length <= 1) return;
        
        let prevIndex;
        if (isShuffle) {
            do {
                prevIndex = Math.floor(Math.random() * list.length);
            } while (currentStation && list[prevIndex].id === currentStation.id && list.length > 1);
        } else {
            const currentIndex = list.findIndex(s => s.id === currentStation?.id);
            prevIndex = (currentIndex - 1 + list.length) % list.length;
        }
        
        playStation(list[prevIndex]);
    }

    function updateShuffleUI() {
        shuffleBtn.classList.toggle('is-active', isShuffle);
        localStorage.setItem('adventist-shuffle', isShuffle);
    }

    function updatePlayToggleIcon(isPlaying) {
        playToggle.innerHTML = isPlaying 
            ? '<ion-icon name="pause-circle"></ion-icon>' 
            : '<ion-icon name="play-circle"></ion-icon>';
    }

    // --- Event Listeners ---
    
    // Global delegation for Card clicks, Fav buttons and Language chips
    document.addEventListener('click', (e) => {
        const favBtn = e.target.closest('.c-card__fav-button');
        const card = e.target.closest('.c-card');
        const chip = e.target.closest('.c-filter-chip');
        
        if (chip) {
            selectedLanguage = chip.dataset.lang;
            localStorage.setItem('adventist-last-lang', selectedLanguage);
            renderLanguageFilters();
            renderAll();
            return;
        }

        if (favBtn) {
            e.stopPropagation();
            toggleFavorite(favBtn.dataset.id);
            return;
        }

        if (card) {
            const station = allStations.find(s => s.id == card.dataset.id);
            if (station) playStation(station);
        }
    });

    playerFavBtn.onclick = () => {
        if (currentStation) toggleFavorite(currentStation.id);
    };

    shuffleBtn.onclick = () => {
        isShuffle = !isShuffle;
        updateShuffleUI();
    };

    nextBtn.onclick = () => playNext();
    prevBtn.onclick = () => playPrev();

    // Play/Pause
    playToggle.addEventListener('click', () => {
        if (!audio.src && !hls) return;
        if (audio.paused) {
            audio.play();
            updatePlayToggleIcon(true);
        } else {
            audio.pause();
            updatePlayToggleIcon(false);
        }
    });

    // Search Logic
    searchInput.addEventListener('input', (e) => {
        renderAll();
    });

    // Sidebar navigation
    navHome.addEventListener('click', () => {
        mainContent.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // Header scroll
    mainContent.addEventListener('scroll', () => {
        if (mainContent.scrollTop > 50) {
            header.classList.add('is-scrolled');
        } else {
            header.classList.remove('is-scrolled');
        }
    });

    audio.addEventListener('timeupdate', () => {
        if (audio.duration && !isNaN(audio.duration) && audio.duration !== Infinity) {
            const percent = (audio.currentTime / audio.duration) * 100;
            progressFill.style.width = `${percent}%`;
        } else {
            progressFill.style.width = '100%';
        }
    });

    // Kickoff
    init();
});
