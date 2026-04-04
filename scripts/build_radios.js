const fs = require('fs');
const path = require('path');

const RAW_FILE = path.join(__dirname, '../api/radios_list.json');
const OUTPUT_FILE = path.join(__dirname, '../api/radios.json');
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

  console.log(`Successfully built ${OUTPUT_FILE} and ${WEB_OUTPUT_FILE} with ${updatedEstaciones.length} stations.`);
} catch (error) {
  console.error('An error occurred during the build process:', error.message);
  process.exit(1);
}
