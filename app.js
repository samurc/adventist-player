// Assets paths from previous generation
const HERO_PATH = 'music_hero_background_1774798923352.png';
const ALBUM_PATHS = [
    'album_cover_1_1774799040146.png',
    'album_cover_2_1774799101973.png',
    'album_cover_3_1774799127094.png',
    'album_cover_4_1774799150602.png'
];

const mockAlbums = [
    { title: "Neon Nights", artist: "Retro Wave", cover: ALBUM_PATHS[0] },
    { title: "Midnight Jazz", artist: "The Blue Quartet", cover: ALBUM_PATHS[1] },
    { title: "Acoustic Soul", artist: "Nature Strings", cover: ALBUM_PATHS[2] },
    { title: "Cyber Glitch", artist: "Digital Void", cover: ALBUM_PATHS[3] },
    { title: "Chill Vibes", artist: "Lofi Beats", cover: ALBUM_PATHS[0] },
    { title: "Smooth Flow", artist: "Smooth Collective", cover: ALBUM_PATHS[1] }
];

document.addEventListener('DOMContentLoaded', () => {
    const heroSection = document.getElementById('hero-section');
    const mainContent = document.getElementById('main-content');
    const header = document.getElementById('header');
    const trendingGrid = document.getElementById('trending-grid');
    const newReleasesGrid = document.getElementById('new-releases-grid');

    // Set Hero Background
    if (heroSection) {
        heroSection.style.backgroundImage = `url('${HERO_PATH}')`;
    }

    // Render Grids using BEMIT classes
    function renderGrid(container, albums) {
        if (!container) return;
        container.innerHTML = albums.map(album => `
            <div class="c-card">
                <div class="c-card__image" style="background-image: url('${album.cover}')"></div>
                <div class="c-card__play-button">
                    <ion-icon name="play" style="font-size: 24px; color: white;"></ion-icon>
                </div>
                <h3 class="c-card__title">${album.title}</h3>
                <p class="c-card__description">${album.artist}</p>
            </div>
        `).join('');
    }

    renderGrid(trendingGrid, mockAlbums);
    renderGrid(newReleasesGrid, [...mockAlbums].reverse());

    // Header scroll effect with BEMIT state
    if (mainContent && header) {
        mainContent.addEventListener('scroll', () => {
            if (mainContent.scrollTop > 50) {
                header.classList.add('is-scrolled');
            } else {
                header.classList.remove('is-scrolled');
            }
        });
    }

    // Mock Player Interactivity
    const currentTitle = document.getElementById('current-title');
    const currentArtist = document.getElementById('current-artist');
    const currentCover = document.getElementById('current-cover');
    const playToggle = document.getElementById('main-play-toggle');

    // Set initial track
    if (mockAlbums.length > 0) {
        if (currentTitle) currentTitle.innerText = mockAlbums[0].title;
        if (currentArtist) currentArtist.innerText = mockAlbums[0].artist;
        if (currentCover) currentCover.style.backgroundImage = `url('${mockAlbums[0].cover}')`;
    }

    // Click on cards to "play"
    document.addEventListener('click', (e) => {
        const card = e.target.closest('.c-card');
        if (card) {
            const title = card.querySelector('.c-card__title').innerText;
            const artist = card.querySelector('.c-card__description').innerText;
            const cover = card.querySelector('.c-card__image').style.backgroundImage;

            if (currentTitle) currentTitle.innerText = title;
            if (currentArtist) currentArtist.innerText = artist;
            if (currentCover) currentCover.style.backgroundImage = cover;
            
            // Animation feel
            card.style.transform = 'scale(0.95)';
            setTimeout(() => card.style.transform = 'scale(1)', 100);
        }
    });

    // Play button toggle
    let isPlaying = false;
    if (playToggle) {
        playToggle.addEventListener('click', () => {
            isPlaying = !isPlaying;
            playToggle.innerHTML = isPlaying 
                ? '<ion-icon name="pause-circle"></ion-icon>' 
                : '<ion-icon name="play-circle"></ion-icon>';
        });
    }
});
