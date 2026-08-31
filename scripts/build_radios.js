const fs = require('fs');
const path = require('path');

const RAW_FILE = path.join(__dirname, 'radios_list.json');
const OUTPUT_FILE = path.join(__dirname, '../api/appradios.json');
const WEB_OUTPUT_FILE = path.join(__dirname, '../api/web.json');

try {
  // Read the raw list of radio stations
  if (!fs.existsSync(RAW_FILE)) {
    console.error(`Error: ${RAW_FILE} not found.`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(RAW_FILE, 'utf8');
  const estaciones = JSON.parse(rawData);

  if (!Array.isArray(estaciones)) {
    console.error('Error: The content of radios_list.json must be an array.');
    process.exit(1);
  }

  const slugify = (text) => {
    return text
      .toString()
      .normalize('NFD') // split accented characters into their base characters and diacritical marks
      .replace(/[\u0300-\u036f]/g, '') // remove all the accents
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-') // replace spaces with -
      .replace(/[^\w-]+/g, '') // remove all non-word chars
      .replace(/--+/g, '-') // replace multiple - with single -
      .replace(/^-+/, '') // trim - from start of text
      .replace(/-+$/, ''); // trim - from end of text
  };

  const generatedIds = new Set();

  const updatedEstaciones = estaciones.map((station) => {
    const rawId = [station.nombre, station.region, station.dial]
      .filter(Boolean)
      .join('-');
    
    let slug = slugify(rawId);
    
    // Ensure uniqueness
    let counter = 1;
    let finalSlug = slug;
    while (generatedIds.has(finalSlug)) {
      finalSlug = `${slug}-${counter}`;
      counter++;
    }
    
    generatedIds.add(finalSlug);

    return {
      id: finalSlug,
      ...station,
    };
  }).sort((a, b) => 
    a.pais.localeCompare(b.pais) || a.nombre.localeCompare(b.nombre)
  );

  // Create the final structure
  const result = {
    statusCode: 200,
    estaciones: updatedEstaciones,
  };

  // Write the results
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');
  fs.writeFileSync(WEB_OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  // --- NEW: Generate Static Folders for SEO ---
  const langs = ['es', 'en', 'pt'];
  const templates = {};
  
  langs.forEach(lang => {
    const templatePath = path.join(__dirname, `../${lang}/index.html`);
    if (fs.existsSync(templatePath)) {
      templates[lang] = fs.readFileSync(templatePath, 'utf8');
    }
  });

  console.log('Generating static pages for stations...');
  
  updatedEstaciones.forEach((station) => {
    langs.forEach(langCode => {
        const template = templates[langCode];
        if (!template) return;

        const stationUrl = `https://adventistplayer.org/${langCode}/${station.id}/`;
        const stationName = station.nombre;
        const stationLocation = station.dial !== "" ? `${station.region} - ${station.dial}` : station.pais;
        const stationFullTitle = `${stationName} | ${stationLocation} - Adventist Player`;
        
        let description = "";
        if (langCode === 'es') description = `Disfruta de la programación en vivo de <strong>${stationName}</strong> (${stationLocation}). Sintoniza música cristiana, mensajes de esperanza y programas espirituales las 24 horas del día. Adventist Player te conecta con las mejores emisoras adventistas del mundo en un solo lugar.`;
        else if (langCode === 'en') description = `Enjoy live programming from <strong>${stationName}</strong> (${stationLocation}). Tune in to Christian music, messages of hope, and spiritual programs 24 hours a day. Adventist Player connects you with the best Adventist stations in the world in one place.`;
        else description = `Aproveite a programação ao vivo da <strong>${stationName}</strong> (${stationLocation}). Sintonize música cristã, mensagens de esperança e programas espirituais 24 horas por dia. O Adventist Player conecta você com as melhores emissoras adventistas do mundo em um só lugar.`;

        const cleanDescription = description.replace(/<\/?strong>/g, '');

        // Simple replacement logic for meta tags
        let html = template;
        
        // Replace Title
        html = html.replace(/<title>(.*?)<\/title>/, `<title>${stationFullTitle}</title>`);
        
        // Replace Canonical and OG/Twitter URLs
        html = html.replace(/rel="canonical" href="(.*?)"/, `rel="canonical" href="${stationUrl}"`);
        html = html.replace(/property="og:url" content="(.*?)"/g, `property="og:url" content="${stationUrl}"`);
        html = html.replace(/property="twitter:url" content="(.*?)"/g, `property="twitter:url" content="${stationUrl}"`);
        
        // Replace OG/Twitter Titles
        html = html.replace(/property="og:title" content="(.*?)"/g, `property="og:title" content="${stationFullTitle}"`);
        html = html.replace(/property="twitter:title" content="(.*?)"/g, `property="twitter:title" content="${stationFullTitle}"`);

        // Replace Descriptions
        html = html.replace(/name="description" content="(.*?)"/, `name="description" content="${cleanDescription}"`);
        html = html.replace(/property="og:description" content="(.*?)"/g, `property="og:description" content="${cleanDescription}"`);
        html = html.replace(/property="twitter:description" content="(.*?)"/g, `property="twitter:description" content="${cleanDescription}"`);

        // Replace H1 Title
        html = html.replace(/<h1(.*?)id="hero-title"(.*?)>(.*?)<\/h1>/, `<h1$1id="hero-title"$2>${stationName}</h1>`);
        
        // Populate Description Paragraph
        html = html.replace(/<p class="c-hero__description" data-i18n="hero.description">.*?<\/p>/, `<p class="c-hero__description" data-i18n="hero.description">${description}</p>`);

        // Replace Hero Image Alt and Src
        html = html.replace(/<img id="hero-image" src=".*?" alt=".*?">/, `<img id="hero-image" src="${station.imgMobile}" alt="${stationName}">`);

        // Add Hero Background Image
        html = html.replace(/<section class="c-hero" id="hero-section">/, `<section class="c-hero" id="hero-section" style="background-image: url('${station.imgMobile}'); --hero-bg: url('${station.imgMobile}');">`);

        // Inject Hreflang Alternates
        const alternates = langs.map(l => `<link rel="alternate" hreflang="${l}" href="https://adventistplayer.org/${l}/${station.id}/">`).join('\n    ');
        html = html.replace('</head>', `    ${alternates}\n</head>`);

        // Replace OG/Twitter Images
        if (station.imgMobile) {
            html = html.replace(/property="og:image" content="(.*?)"/g, `property="og:image" content="${station.imgMobile}"`);
            html = html.replace(/property="twitter:image" content="(.*?)"/g, `property="twitter:image" content="${station.imgMobile}"`);
        }

        // Create directory
        const stationDir = path.join(__dirname, `../${langCode}/${station.id}`);
        if (!fs.existsSync(stationDir)) {
        fs.mkdirSync(stationDir, { recursive: true });
        }

        // Write index.html
        fs.writeFileSync(path.join(stationDir, 'index.html'), html, 'utf8');
    });
  });

  // --- NEW: Generate sitemap.xml ---
  console.log('Generating sitemap.xml...');
  const date = new Date().toISOString().split('T')[0];
  let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
   <url>
      <loc>https://adventistplayer.org/</loc>
      <lastmod>${date}</lastmod>
      <changefreq>daily</changefreq>
      <priority>1.0</priority>
   </url>
   <url>
      <loc>https://adventistplayer.org/es/</loc>
      <lastmod>${date}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.9</priority>
      <xhtml:link rel="alternate" hreflang="es" href="https://adventistplayer.org/es/"/>
      <xhtml:link rel="alternate" hreflang="en" href="https://adventistplayer.org/en/"/>
      <xhtml:link rel="alternate" hreflang="pt" href="https://adventistplayer.org/pt/"/>
   </url>
   <url>
      <loc>https://adventistplayer.org/en/</loc>
      <lastmod>${date}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.9</priority>
      <xhtml:link rel="alternate" hreflang="es" href="https://adventistplayer.org/es/"/>
      <xhtml:link rel="alternate" hreflang="en" href="https://adventistplayer.org/en/"/>
      <xhtml:link rel="alternate" hreflang="pt" href="https://adventistplayer.org/pt/"/>
   </url>
   <url>
      <loc>https://adventistplayer.org/pt/</loc>
      <lastmod>${date}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.9</priority>
      <xhtml:link rel="alternate" hreflang="es" href="https://adventistplayer.org/es/"/>
      <xhtml:link rel="alternate" hreflang="en" href="https://adventistplayer.org/en/"/>
      <xhtml:link rel="alternate" hreflang="pt" href="https://adventistplayer.org/pt/"/>
   </url>`;

  updatedEstaciones.forEach(station => {
    langs.forEach(langCode => {
        sitemap += `
   <url>
      <loc>https://adventistplayer.org/${langCode}/${station.id}/</loc>
      <lastmod>${date}</lastmod>
      <changefreq>monthly</changefreq>
      <priority>0.7</priority>
      ${langs.map(l => `<xhtml:link rel="alternate" hreflang="${l}" href="https://adventistplayer.org/${l}/${station.id}/"/>`).join('\n      ')}
   </url>`;
    });
  });

  sitemap += '\n</urlset>';
  fs.writeFileSync(path.join(__dirname, '../sitemap.xml'), sitemap, 'utf8');

  console.log(`Successfully built ${OUTPUT_FILE}, ${WEB_OUTPUT_FILE}, sitemap.xml and ${updatedEstaciones.length} station directories.`);
} catch (error) {
  console.error('An error occurred during the build process:', error);
  process.exit(1);
}
