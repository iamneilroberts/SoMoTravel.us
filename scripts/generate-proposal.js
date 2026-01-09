#!/usr/bin/env node

/**
 * SOMO Travel Proposal Generator
 *
 * Generates an HTML proposal from a trip-details.json file.
 *
 * Usage:
 *   node scripts/generate-proposal.js trips/active/portugal-henderson-jones-mar-2026
 *   node scripts/generate-proposal.js trips/active/portugal-henderson-jones-mar-2026 --output proposal.html
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
SOMO Travel Proposal Generator

Usage:
  node scripts/generate-proposal.js <trip-folder> [--output <filename>]

Examples:
  node scripts/generate-proposal.js trips/active/portugal-henderson-jones-mar-2026
  node scripts/generate-proposal.js trips/active/greek-cruise-may-2026 --output my-proposal.html

The script reads trip-details.json from the specified folder and generates
an HTML proposal file in the same folder.
    `);
    process.exit(0);
}

const tripFolder = args[0];
const outputIndex = args.indexOf('--output');
const outputFilename = outputIndex !== -1 ? args[outputIndex + 1] : 'proposal.html';

// Resolve paths
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, '..');
const tripPath = path.resolve(projectRoot, tripFolder);
const jsonPath = path.join(tripPath, 'trip-details.json');
const templatePath = path.resolve(projectRoot, 'templates', 'proposal-template.html');
const outputPath = path.join(tripPath, outputFilename);

// Check files exist
if (!fs.existsSync(jsonPath)) {
    console.error(`Error: trip-details.json not found at ${jsonPath}`);
    process.exit(1);
}

if (!fs.existsSync(templatePath)) {
    console.error(`Error: Template not found at ${templatePath}`);
    process.exit(1);
}

// Read files
const tripData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
let template = fs.readFileSync(templatePath, 'utf8');

console.log(`\nGenerating proposal for: ${tripData.meta.clientName}`);
console.log(`Destination: ${tripData.meta.destination}`);
console.log(`Dates: ${tripData.meta.dates}\n`);

// Transform trip data into template-ready format
function transformData(data) {
    const result = {
        meta: data.meta,
        travelers: {
            ...data.travelers,
            names: Array.isArray(data.travelers.names) ? data.travelers.names.join(' & ') : data.travelers.names
        },
        hero: {
            emoji: getDestinationEmoji(data.meta.destination),
            duration: `• ${data.itinerary?.days?.length || '?'} Days`,
            tagline: getTagline(data)
        },
        overview: {
            icon: '✨',
            items: getOverviewItems(data),
            description: data.itinerary?.summary || '',
            purpose: data.meta.occasion,
            purposeIcon: '💡'
        },
        generatedDate: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    };

    // Flights
    if (data.flights) {
        result.flights = {
            airline: data.flights.outbound?.airline || 'TBD',
            route: `${data.flights.routing?.recommended?.split(' → ')[0] || 'TBD'} to ${data.meta.destination}`,
            outbound: {
                date: formatDate(data.flights.outbound?.date),
                route: data.flights.outbound?.route || 'TBD',
                notes: data.flights.outbound?.notes || ''
            },
            return: {
                date: formatDate(data.flights.return?.date),
                route: data.flights.return?.route || 'TBD',
                notes: data.flights.return?.departure || ''
            },
            estimatedTotal: data.flights.estimatedTotal?.range || 'TBD',
            note: data.flights.source || ''
        };
    }

    // Lodging
    if (data.lodging) {
        const properties = data.lodging.premium || data.lodging.properties || [];
        result.lodging = {
            properties: properties.map(p => ({
                property: p.property,
                location: p.location,
                nights: p.nights,
                dates: p.dates || '',
                priceRange: p.priceRange,
                description: p.description || '',
                perks: Array.isArray(p.perks) ? p.perks.join(', ') : p.perks,
                url: p.url
            })),
            totalEstimate: calculateLodgingTotal(properties)
        };
    }

    // Itinerary
    if (data.itinerary?.days) {
        result.itinerary = {
            days: data.itinerary.days.map(day => ({
                day: day.day,
                title: day.title,
                dateFormatted: formatDayDate(day.date),
                content: formatDayContent(day),
                highlight: day.highlight || formatDayHighlight(day)
            }))
        };
    }

    // Tours
    result.tours = getAllTours(data);
    result.toursTotal = calculateToursTotal(data);

    // Dining
    result.dining = getDiningData(data);
    result.kimsGem = data.extras?.kims_gem;

    // Extras (hidden gems, photo ops)
    if (data.extras) {
        result.extras = {
            hiddenGems: data.extras.hiddenGems?.map(g => ({
                name: g.name,
                location: g.location,
                description: g.description,
                tip: g.tip || g.whyGem
            })),
            photoOps: data.extras.photoOps?.map(p => ({
                name: p.name,
                tip: p.tip || p.description
            }))
        };
    }

    // Pricing
    if (data.pricing) {
        const pkg = data.pricing.premium || Object.values(data.pricing)[0];
        if (pkg && typeof pkg === 'object') {
            result.pricing = {
                packageName: 'Premium Package',
                travelers: data.travelers.count,
                lineItems: [
                    { label: 'Flights', amount: formatCurrency(pkg.flights) },
                    { label: 'Accommodations', amount: formatCurrency(pkg.lodging) },
                    { label: 'Tours & Activities', amount: formatCurrency(pkg.tours) },
                    { label: 'Transportation', amount: formatCurrency(pkg.transport) },
                    { label: 'Meals (estimate)', amount: formatCurrency(pkg.meals) }
                ].filter(item => item.amount !== '$0'),
                total: formatCurrency(pkg.total),
                perPerson: formatCurrency(pkg.perPerson),
                insuranceNote: 'Highly recommended! Typical cost: ~10% of package. Kim will provide a quote with your booking confirmation.'
            };
        }
    }

    // Not included
    result.notIncluded = [
        'Meals (except where noted in tours)',
        'Attraction entry fees not listed',
        'Personal expenses and souvenirs',
        'Gratuities',
        'Travel insurance (quoted separately)',
        'Passport fees if needed'
    ];

    // Packing guide
    if (data.packingGuide) {
        result.packingGuide = {
            season: getSeasonFromDates(data.meta.dates),
            weather: data.packingGuide.weather,
            essentials: data.packingGuide.essentials,
            style: data.packingGuide.style
        };
    }

    return result;
}

// Helper functions
function getDestinationEmoji(destination) {
    const emojis = {
        'Portugal': '🇵🇹',
        'Greece': '🇬🇷',
        'Greek Islands': '🇬🇷',
        'Italy': '🇮🇹',
        'France': '🇫🇷',
        'Spain': '🇪🇸',
        'Caribbean': '🏝️',
        'Bahamas': '🇧🇸',
        'Mexico': '🇲🇽',
        'Hawaii': '🌺',
        'Alaska': '🏔️'
    };
    for (const [key, emoji] of Object.entries(emojis)) {
        if (destination.toLowerCase().includes(key.toLowerCase())) {
            return emoji;
        }
    }
    return '✈️';
}

function getTagline(data) {
    if (data.locations && data.locations.length > 0) {
        return data.locations.map(l => l.name).join(' • ');
    }
    return data.meta.destination;
}

function getOverviewItems(data) {
    const items = [];
    if (data.itinerary?.days) {
        items.push({ label: 'Duration', value: `${data.itinerary.days.length} Days` });
    }
    items.push({ label: 'Travelers', value: `${data.travelers.adults} Adults` });
    if (data.locations && data.locations.length > 0) {
        items.push({ label: 'Bases', value: data.locations.map(l => l.name).join(' & ') });
    }
    if (data.preferences?.transportation) {
        items.push({ label: 'Style', value: data.preferences.transportation });
    }
    return items;
}

function formatDate(dateStr) {
    if (!dateStr) return 'TBD';
    try {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    } catch {
        return dateStr;
    }
}

function formatDayDate(dateStr) {
    if (!dateStr) return '';
    try {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    } catch {
        return dateStr;
    }
}

function formatDayContent(day) {
    const parts = [];
    if (day.activities) {
        parts.push(...day.activities.map(a => `<p>${a}</p>`));
    }
    if (day.dining) {
        parts.push(`<p><strong>Dining:</strong> ${day.dining}</p>`);
    }
    return parts.join('');
}

function formatDayHighlight(day) {
    // Try to extract highlight from activities or notes
    return null;
}

function calculateLodgingTotal(properties) {
    const total = properties.reduce((sum, p) => sum + (p.total || 0), 0);
    return total > 0 ? `~$${total.toLocaleString()} for ${properties.reduce((n, p) => n + (p.nights || 0), 0)} nights` : null;
}

function getAllTours(data) {
    const tours = [];
    if (data.tours) {
        for (const [city, cityTours] of Object.entries(data.tours)) {
            if (Array.isArray(cityTours)) {
                for (const tour of cityTours) {
                    tours.push({
                        name: tour.name,
                        day: tour.day,
                        duration: tour.duration || '',
                        description: tour.description || (tour.includes ? tour.includes.join(', ') : ''),
                        price: tour.totalFor2 || tour.price,
                        note: tour.note || tour.alcoholNote,
                        url: tour.url,
                        provider: tour.url?.includes('viator') ? 'Viator' : (tour.url?.includes('cp.pt') ? 'CP' : 'provider'),
                        badge: tour.url ? 'Viator' : 'DIY',
                        badgeClass: tour.url ? 'tour' : 'free'
                    });
                }
            }
        }
    }
    return tours.length > 0 ? tours : null;
}

function calculateToursTotal(data) {
    // Simple estimate
    if (data.pricing?.premium?.tours) {
        return `~$${data.pricing.premium.tours} for both travelers`;
    }
    return null;
}

function getDiningData(data) {
    if (!data.extras?.dining) return null;

    const dining = [];
    for (const [city, restaurants] of Object.entries(data.extras.dining)) {
        if (Array.isArray(restaurants)) {
            dining.push({
                city: capitalizeFirst(city),
                restaurants: restaurants.slice(0, 4).map(r => ({
                    name: r.name,
                    url: r.url,
                    type: r.type,
                    price: r.price,
                    note: r.note || r.mustTry
                }))
            });
        }
    }
    return dining.length > 0 ? dining : null;
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatCurrency(amount) {
    if (!amount || amount === 0) return '$0';
    return `~$${amount.toLocaleString()}`;
}

function getSeasonFromDates(dateStr) {
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
                   'July', 'August', 'September', 'October', 'November', 'December'];
    for (const month of months) {
        if (dateStr.includes(month)) {
            return month;
        }
    }
    return '';
}

// Simple template engine (Handlebars-like syntax)
function render(template, data, prefix = '') {
    let result = template;

    // Handle {{#each array}} blocks
    result = result.replace(/\{\{#each\s+(\S+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (match, path, content) => {
        const arr = getNestedValue(data, path);
        if (!Array.isArray(arr)) return '';
        return arr.map((item, index) => {
            let itemContent = content;
            // Replace {{this.property}} with item.property
            itemContent = itemContent.replace(/\{\{this\.(\w+)\}\}/g, (m, prop) => {
                const val = item[prop];
                return val !== undefined && val !== null ? escapeHtml(String(val)) : '';
            });
            // Replace {{{this.property}}} with unescaped item.property
            itemContent = itemContent.replace(/\{\{\{this\.(\w+)\}\}\}/g, (m, prop) => {
                const val = item[prop];
                return val !== undefined && val !== null ? String(val) : '';
            });
            // Replace {{@first}} for first item check
            itemContent = itemContent.replace(/\{\{#unless @first\}\}([\s\S]*?)\{\{\/unless\}\}/g, (m, inner) => {
                return index === 0 ? '' : inner;
            });
            return itemContent;
        }).join('');
    });

    // Handle {{#if condition}} blocks
    result = result.replace(/\{\{#if\s+(\S+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, path, content) => {
        const val = getNestedValue(data, path);
        if (!val || (Array.isArray(val) && val.length === 0)) return '';
        return render(content, data, prefix);
    });

    // Handle {{{unescaped}}} variables
    result = result.replace(/\{\{\{(\S+)\}\}\}/g, (match, path) => {
        const val = getNestedValue(data, path);
        return val !== undefined && val !== null ? String(val) : '';
    });

    // Handle {{escaped}} variables
    result = result.replace(/\{\{(\S+)\}\}/g, (match, path) => {
        const val = getNestedValue(data, path);
        return val !== undefined && val !== null ? escapeHtml(String(val)) : '';
    });

    return result;
}

function getNestedValue(obj, path) {
    return path.split('.').reduce((o, key) => (o && o[key] !== undefined) ? o[key] : undefined, obj);
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Main execution
try {
    const templateData = transformData(tripData);
    const html = render(template, templateData);

    fs.writeFileSync(outputPath, html);
    console.log(`✅ Proposal generated: ${outputPath}`);
    console.log(`\nOpen in browser: file://${outputPath}`);
} catch (error) {
    console.error('Error generating proposal:', error.message);
    process.exit(1);
}
