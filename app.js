// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDm0QzUQSAy7Gnx-gIR4R34YX49fM4ttkQ",
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

const API_URL = './api/web.json';

let allStations = [];
let favorites = (JSON.parse(localStorage.getItem('adventist-favs')) || []).filter(id => id !== null && id !== undefined && !Number.isNaN(id));
if (favorites.some(id => typeof id === 'number')) {
    // If we have numbers, we might want to keep them just in case, but usually they are from the old system.
    // For now, let's keep them but strictly they won't match slugs.
}
localStorage.setItem('adventist-favs', JSON.stringify(favorites));

let currentStation = null;
let hls = null;
let selectedLanguage = localStorage.getItem('adventist-last-lang');
if (!selectedLanguage || selectedLanguage === 'Todos') selectedLanguage = 'Español';
let isShuffle = localStorage.getItem('adventist-shuffle') === 'true';
let pendingStation = null;
let currentHeroStation = null;
let autoplayTimerInterval = null;

document.addEventListener('DOMContentLoaded', () => {
    const mainContent = document.getElementById('main-content');
    const header = document.getElementById('header');
    
    // Grids
    const allStationsGrid = document.getElementById('all-stations-grid');
    const favoritesGrid = document.getElementById('favorites-grid');
    const favoritesSection = document.getElementById('favorites-section');
    const languageFilters = document.getElementById('language-filters');

    // UI Elements
    const searchHeader = document.getElementById('station-search-header');
    const searchSection = document.getElementById('station-search-section');
    const getSearchQuery = () => {
        return (searchHeader?.value || searchSection?.value || '').toLowerCase();
    };
    const audio = document.getElementById('audio-player');
    const heroSignal = document.getElementById('hero-signal');
    const heroTitle = document.getElementById('hero-title');
    const heroSection = document.getElementById('hero-section');
    const heroImage = document.getElementById('hero-image');
    const heroPlayBtn = document.getElementById('hero-play-btn');
    const heroFavBtn = document.getElementById('hero-fav-btn');
    const heroShareBtn = document.getElementById('hero-share-btn');

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
    const testingBanner = document.getElementById('testing-banner');
    const closeBannerBtn = document.getElementById('close-banner');

    const sidebar = document.getElementById('sidebar');
    const sidebarBackdrop = document.getElementById('sidebar-backdrop');
    const mobileMenuOpen = document.getElementById('mobile-menu-open');
    const mobileMenuClose = document.getElementById('mobile-menu-close');

    const autoplayOverlay = document.getElementById('autoplay-overlay');
    const autoplayStationName = document.getElementById('autoplay-station-name');
    const autoplayTimer = document.getElementById('autoplay-timer');
    
    // Auto-hide Closed Testing Banner if not on Android
    const isAndroid = /Android/i.test(navigator.userAgent);
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isAndroid && !isLocalhost && testingBanner) {
        testingBanner.closest('section').style.display = 'none';
    }

    // --- Data Fetch ---
    async function init() {
        try {
            const response = await fetch(API_URL);
            const data = await response.json();
            allStations = data.estaciones;

            // Detect station and language from URL
            const urlParams = new URLSearchParams(window.location.search);
            const stationIdFromUrl = urlParams.get('radio');
            const langFromUrl = urlParams.get('lang') || urlParams.get('idioma');
            let initialStation = null;
            let shouldAutoPlay = false;

            if (langFromUrl) {
                selectedLanguage = langFromUrl;
                localStorage.setItem('adventist-last-lang', selectedLanguage);
            }

            if (stationIdFromUrl) {
                initialStation = allStations.find(s => s.id === stationIdFromUrl);
                if (initialStation) {
                    shouldAutoPlay = true;
                    // If no explicit lang parameter is provided, sync with the radio station's language
                    if (!langFromUrl) {
                        selectedLanguage = initialStation.idioma;
                        localStorage.setItem('adventist-last-lang', selectedLanguage);
                    }
                }
            }

            // Fallback to localStorage or first Spanish station
            if (!initialStation) {
                const lastPlayedId = localStorage.getItem('adventist-last-played');
                initialStation = allStations.find(s => s.id == lastPlayedId) || 
                                 allStations.find(s => s.idioma === 'Español') || 
                                 allStations[0];
            }

            // Ensure selectedLanguage is valid for filters
            const validLanguages = [...new Set(allStations.map(s => s.idioma))];
            if (!validLanguages.includes(selectedLanguage)) {
                selectedLanguage = initialStation?.idioma || validLanguages[0] || 'Español';
                localStorage.setItem('adventist-last-lang', selectedLanguage);
            }
            
            renderLanguageFilters();
            renderAll();
            updateShuffleUI();

            if (initialStation) {
                if (shouldAutoPlay) {
                    playStation(initialStation);
                } else {
                    updateHero(initialStation);
                    updatePlayerUI(initialStation);
                }
            }
        } catch (error) {
            console.error('Error fetching stations:', error);
            allStationsGrid.innerHTML = '<p class="u-text-muted">Error al cargar las estaciones.</p>';
        }
    }

    // --- Render Logic ---
    function renderAll() {
        // Filter stations based on search and language
        const query = getSearchQuery();
        const filtered = allStations.filter(s => {
            const matchesQuery = !query || 
                s.nombre.toLowerCase().includes(query) || 
                s.pais.toLowerCase().includes(query) ||
                s.region.toLowerCase().includes(query);
            const matchesLang = s.idioma === selectedLanguage;
            return matchesQuery && matchesLang;
        });

        const allStationsTitle = document.getElementById('all-stations-title');
        allStationsTitle.innerText = query ? 'Resultados de búsqueda' : 'Todas las Radios';

        renderGrid(allStationsGrid, filtered);
        updateFavoritesUI();
    }

    function getFilteredStations() {
        const query = getSearchQuery();
        return allStations.filter(s => {
            const matchesQuery = !query || 
                s.nombre.toLowerCase().includes(query) || 
                s.pais.toLowerCase().includes(query) ||
                s.region.toLowerCase().includes(query);
            const matchesLang = s.idioma === selectedLanguage;
            return matchesQuery && matchesLang;
        });
    }

    function renderLanguageFilters() {
        const languages = [...new Set(allStations.map(s => s.idioma))].sort((a, b) => a.localeCompare(b));
        languageFilters.innerHTML = languages.map(lang => `
            <button class="c-filter-chip ${selectedLanguage === lang ? 'is-active' : ''}" data-lang="${lang}">
                ${lang}
            </button>
        `).join('');
    }

    function renderGrid(container, stations, style = 'normal') {
        if (!container) return;
        const isRectangular = style === 'rectangular';
        const cardClass = isRectangular ? 'c-card c-card--rectangular' : 'c-card c-swipe-content';
        
        container.innerHTML = stations.map(station => {
            const isFav = favorites.includes(station.id);
            const swipeActionsHtml = isRectangular ? '' : `
                <div class="c-swipe-actions">
                    <a href="${station.web}" target="_blank" class="c-swipe-btn c-swipe-btn--web">
                        <ion-icon name="globe-outline"></ion-icon>
                    </a>
                    <button class="c-swipe-btn c-swipe-btn--fav ${isFav ? 'is-favorite' : ''}" data-id="${station.id}">
                        <ion-icon name="${isFav ? 'heart' : 'heart-outline'}"></ion-icon>
                    </button>
                </div>
            `;
            const swipeIndicatorHtml = isRectangular ? '' : `
                <div class="c-card__swipe-indicator">
                    <ion-icon name="chevron-back-outline"></ion-icon>
                </div>
            `;

            return `
                <div class="c-swipe-item" data-id="${station.id}">
                    ${swipeActionsHtml}
                    <div class="${cardClass}" data-id="${station.id}" role="link" aria-label="Escuchar ${station.nombre} de ${station.pais}">
                        <img class="c-card__image" src="${station.imgMobile}" alt="Radio ${station.nombre} - ${station.pais}" loading="lazy">
                        <div class="c-card__play-button">
                            <ion-icon name="play" style="font-size: 24px; color: white;"></ion-icon>
                        </div>
                        <div class="c-card__body">
                            <h3 class="c-card__title">${station.nombre}</h3>
                            <p class="c-card__description">${station.dial != "" ? (station.region + " - " + station.dial) : station.pais}</p>
                        </div>
                        ${swipeIndicatorHtml}
                    </div>
                </div>
            `;
        }).join('');
    }

    function updateFavoritesUI() {
        const favStations = allStations.filter(s => favorites.includes(s.id));
        if (favStations.length > 0) {
            favoritesSection.style.display = 'block';
            renderGrid(favoritesGrid, favStations, 'rectangular');
        } else {
            favoritesSection.style.display = 'none';
        }
    }

    function updateHero(station) {
        currentHeroStation = station;
        heroSignal.innerText = station.dial != "" ? (station.region + " - " + station.dial) : station.pais;
        heroTitle.innerText = station.nombre;
        const imgUrl = `url('${station.imgMobile}')`;
        heroSection.style.backgroundImage = imgUrl;
        heroSection.style.setProperty('--hero-bg', imgUrl);
        if (heroImage) heroImage.src = station.imgMobile;
        heroPlayBtn.onclick = () => playStation(station);
        
        const isFav = favorites.includes(station.id);
        heroFavBtn.innerHTML = `<ion-icon name="${isFav ? 'heart' : 'heart-outline'}"></ion-icon>`;
        heroFavBtn.classList.toggle('is-favorite', isFav);
        heroFavBtn.onclick = (e) => {
            e.stopPropagation();
            toggleFavorite(station.id);
        };

        // WhatsApp Button Logic
        let heroWABtn = document.getElementById('hero-wa-btn');
        if (station.celularContacto) {
            if (!heroWABtn) {
                heroWABtn = document.createElement('a');
                heroWABtn.id = 'hero-wa-btn';
                heroWABtn.className = 'c-button c-button--outline u-margin-left-12';
                heroWABtn.target = '_blank';
                heroWABtn.innerHTML = '<ion-icon name="logo-whatsapp"></ion-icon>';
                heroFavBtn.after(heroWABtn);
            }
            heroWABtn.href = `https://wa.me/${station.celularContacto}`;
            heroWABtn.style.display = 'inline-flex';
        } else if (heroWABtn) {
            heroWABtn.style.display = 'none';
        }

        // Web Button Logic
        let heroWebBtn = document.getElementById('hero-web-btn');
        if (station.web) {
            if (!heroWebBtn) {
                heroWebBtn = document.createElement('a');
                heroWebBtn.id = 'hero-web-btn';
                heroWebBtn.rel = 'noopener';
                heroWebBtn.className = 'c-button c-button--outline u-margin-left-12';
                heroWebBtn.target = '_blank';
                heroWebBtn.innerHTML = '<ion-icon name="globe-outline"></ion-icon>';
                // Insert after WA if it exists, otherwise after Fav
                const afterEl = document.getElementById('hero-wa-btn') || heroFavBtn;
                afterEl.after(heroWebBtn);
            }
            heroWebBtn.href = station.web;
            heroWebBtn.style.display = 'inline-flex';
        } else if (heroWebBtn) {
            heroWebBtn.style.display = 'none';
        }
    }

    function toggleFavorite(id) {
        if (!id) return;
        
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
        
        // Re-update hero if it's the same station
        const currentHeroStation = allStations.find(s => s.nombre === heroTitle.innerText);
        if (currentHeroStation) updateHero(currentHeroStation);
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
        currentArtist.innerText = `${station.dial != "" ? (station.region + " - " + station.dial) : station.pais}`;
        currentCover.src = station.imgMobile;
        currentCover.alt = `Radio ${station.nombre} - ${station.pais}`;
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

    const handleAutoplayFailure = (station) => {
        if (!autoplayOverlay) return;
        pendingStation = station;
        if (autoplayStationName) autoplayStationName.innerText = station.nombre;
        autoplayOverlay.classList.add('is-visible');

        // 5-second countdown to auto-close
        let timeLeft = 5;
        const updateTimer = () => {
            if (autoplayTimer) autoplayTimer.innerText = `Cerrando en ${timeLeft}...`;
        };
        
        updateTimer();
        clearInterval(autoplayTimerInterval);
        autoplayTimerInterval = setInterval(() => {
            timeLeft--;
            updateTimer();
            if (timeLeft <= 0) {
                clearInterval(autoplayTimerInterval);
                autoplayOverlay.classList.remove('is-visible');
                pendingStation = null;
            }
        }, 1000);
    };

    // --- Playback Logic ---
    async function playStation(station, isRetry = false) {
        // Update URL and Title (SEO / UX)
        const url = new URL(window.location);
        url.searchParams.set('radio', station.id);
        // Preserve current lang if it exists
        if (selectedLanguage) {
            url.searchParams.set('lang', selectedLanguage);
        }
        window.history.replaceState({ path: url.href }, '', url.href);
        document.title = `Escuchando ${station.nombre} | Adventist Player`;

        // Save State
        localStorage.setItem('adventist-last-played', station.id);
        
        // UI Update
        updatePlayerUI(station);
        updateHero(station);

        const streamUrl = station.medialiveUrl;

        const startPlayback = async () => {
            try {
                await audio.play();
                updatePlayToggleIcon(true);
                if (autoplayOverlay) autoplayOverlay.classList.remove('is-visible');
            } catch (error) {
                if (error.name === 'NotAllowedError') {
                    handleAutoplayFailure(station);
                }
                updatePlayToggleIcon(false);
            }
        };

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
                hls.on(Hls.Events.MANIFEST_PARSED, startPlayback);
                hls.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) handleError();
                });
            } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
                audio.src = streamUrl;
                audio.onerror = handleError;
                startPlayback();
            }
        } else {
            audio.src = streamUrl;
            audio.onerror = handleError;
            startPlayback();
        }
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
        if (playToggle.classList.contains('is-loading')) return; // Don't overwrite if loading
        playToggle.innerHTML = isPlaying 
            ? '<ion-icon name="pause"></ion-icon>' 
            : '<ion-icon name="play"></ion-icon>';
    }

    function setBtnLoading(isLoading) {
        if (isLoading) {
            playToggle.classList.add('is-loading');
            playToggle.innerHTML = '<ion-icon name="sync-outline"></ion-icon>';
        } else {
            playToggle.classList.remove('is-loading');
            updatePlayToggleIcon(!audio.paused);
        }
    }

    // --- Event Listeners ---
    
    // Click delegation for all cards and actions
    document.addEventListener('click', (e) => {
        const favBtn = e.target.closest('.c-card__fav-button, .c-swipe-btn--fav');
        const webBtn = e.target.closest('.c-swipe-btn--web');
        const card = e.target.closest('.c-card');
        const chip = e.target.closest('.c-filter-chip');
        
        if (chip) {
            selectedLanguage = chip.dataset.lang;
            localStorage.setItem('adventist-last-lang', selectedLanguage);

            // Update URL
            const url = new URL(window.location);
            url.searchParams.set('lang', selectedLanguage);
            window.history.replaceState({ path: url.href }, '', url.href);

            renderLanguageFilters();
            renderAll();
            return;
        }

        if (favBtn) {
            e.stopPropagation();
            toggleFavorite(favBtn.dataset.id);
            return;
        }

        if (webBtn) {
            e.stopPropagation();
            // Link handles itself but we stop propagation to avoid playing radio
            return;
        }

        if (card) {
            // Only play if not currently swiped
            if (card.style.transform === 'translateX(-140px)') {
                card.style.transform = 'translateX(0)';
                const actions = card.parentElement.querySelector('.c-swipe-actions');
                if (actions) {
                    setTimeout(() => {
                        if (card.style.transform === 'translateX(0px)' || card.style.transform === 'translateX(0)') {
                            actions.style.visibility = 'hidden';
                            actions.style.pointerEvents = 'none';
                        }
                    }, 300);
                }
                return;
            }
            const station = allStations.find(s => s.id == card.dataset.id);
            if (station) playStation(station);
        }
    });

    // --- Swipe Action Logic (Mobile Only) ---
    let touchStartX = 0;
    let touchStartY = 0;
    let currentSwipedEl = null;

    document.addEventListener('touchstart', (e) => {
        const swipable = e.target.closest('.c-swipe-content');
        if (!swipable || window.innerWidth > 768) return;

        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;

        // Close previous if different
        if (currentSwipedEl && currentSwipedEl !== swipable) {
            currentSwipedEl.style.transform = 'translateX(0)';
            currentSwipedEl = null;
        }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        const swipable = e.target.closest('.c-swipe-content');
        if (!swipable || window.innerWidth > 768) return;

        const touchX = e.touches[0].clientX;
        const touchY = e.touches[0].clientY;
        const diffX = touchStartX - touchX;
        const diffY = Math.abs(touchStartY - touchY);

        // If swiping mostly horizontally
        if (diffX > 10 && diffX < 160 && diffY < 30) {
            swipable.style.transition = 'none';
            // Show hidden actions
            const actions = swipable.parentElement.querySelector('.c-swipe-actions');
            if (actions) {
                actions.style.visibility = 'visible';
                actions.style.pointerEvents = 'auto';
            }
            // Allow swiping up to 140px (width of 2 buttons)
            const translate = Math.min(diffX, 140);
            swipable.style.transform = `translateX(-${translate}px)`;
            
            // Prevent vertical scroll if we are clearly swiping horizontal
            if (diffX > 30) {
                if (e.cancelable) e.preventDefault();
            }
        }
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
        const swipable = e.target.closest('.c-swipe-content');
        if (!swipable || window.innerWidth > 768) return;

        swipable.style.transition = '';
        const touchEndX = e.changedTouches[0].clientX;
        const diffX = touchStartX - touchEndX;

        if (diffX > 70) {
            // Lock Open
            swipable.style.transform = 'translateX(-140px)';
            currentSwipedEl = swipable;
        } else {
            // Close
            swipable.style.transform = 'translateX(0)';
            const actions = swipable.parentElement.querySelector('.c-swipe-actions');
            if (actions) {
                setTimeout(() => {
                    if (swipable.style.transform === 'translateX(0px)' || swipable.style.transform === 'translateX(0)') {
                        actions.style.visibility = 'hidden';
                        actions.style.pointerEvents = 'none';
                    }
                }, 300);
            }
            if (currentSwipedEl === swipable) currentSwipedEl = null;
        }
    }, { passive: true });

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
        if (!audio.src && !hls) {
            if (currentStation) {
                playStation(currentStation);
            }
            return;
        }
        if (audio.paused) {
            audio.play();
            updatePlayToggleIcon(true);
        } else {
            audio.pause();
            updatePlayToggleIcon(false);
        }
    });

    // Search Logic
    const handleSearchInput = (e) => {
        const value = e.target.value;
        if (searchHeader) searchHeader.value = value;
        if (searchSection) searchSection.value = value;
        renderAll();
    };

    if (searchHeader) searchHeader.addEventListener('input', handleSearchInput);
    if (searchSection) searchSection.addEventListener('input', handleSearchInput);

    // Sidebar navigation
    navHome.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    if (closeBannerBtn && testingBanner) {
        closeBannerBtn.onclick = () => {
            testingBanner.closest('section').style.display = 'none';
        }
    }

    // Mobile Sidebar Toggle
    const toggleSidebar = (show) => {
        sidebar.classList.toggle('is-open', show);
        sidebarBackdrop.classList.toggle('is-open', show);
    };

    if (mobileMenuOpen) mobileMenuOpen.onclick = () => toggleSidebar(true);
    if (mobileMenuClose) mobileMenuClose.onclick = () => toggleSidebar(false);
    if (sidebarBackdrop) sidebarBackdrop.onclick = () => toggleSidebar(false);

    // Auto-close on nav click (mobile)
    document.querySelectorAll('.c-nav-item').forEach(item => {
        item.addEventListener('click', () => {
            toggleSidebar(false);
        });
    });

    // Header scroll
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            header.classList.add('is-scrolled');
        } else {
            header.classList.remove('is-scrolled');
        }
    });

    // Buffering / Loading State
    audio.addEventListener('waiting', () => setBtnLoading(true));
    audio.addEventListener('playing', () => setBtnLoading(false));
    audio.addEventListener('pause', () => setBtnLoading(false));
    audio.addEventListener('error', () => setBtnLoading(false));
    audio.addEventListener('canplay', () => setBtnLoading(false));

    if (heroShareBtn) {
        heroShareBtn.onclick = () => {
            if (!currentHeroStation) return;
            const shareText = `Estoy escuchando ${currentHeroStation.nombre} en AdventistPlayer.`;
            const shareUrl = window.location.href;
            
            if (navigator.share) {
                navigator.share({
                    title: 'Adventist Player',
                    text: shareText,
                    url: shareUrl
                }).catch(err => console.log('Error sharing:', err));
            } else {
                navigator.clipboard.writeText(`${shareText} ${shareUrl}`)
                    .then(() => {
                        const originalText = heroShareBtn.querySelector('span').innerText;
                        heroShareBtn.querySelector('span').innerText = '¡Copiado!';
                        setTimeout(() => {
                            heroShareBtn.querySelector('span').innerText = originalText;
                        }, 2000);
                    })
                    .catch(err => console.log('Error copying:', err));
            }
        };
    }

    if (autoplayOverlay) {
        autoplayOverlay.onclick = () => {
            clearInterval(autoplayTimerInterval);
            if (pendingStation) {
                playStation(pendingStation);
            }
        };
    }

    // Kickoff
    init();

    // Register Service Worker
    if ('serviceWorker' in navigator && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js')
                .then(registration => {
                    console.log('SW registered: ', registration);
                })
                .catch(registrationError => {
                    console.log('SW registration failed: ', registrationError);
                });
        });

        // Handle updates: reload when the new SW takes over
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return;
            refreshing = true;
            window.location.reload();
        });
    }
});
