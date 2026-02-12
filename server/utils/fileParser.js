const fs = require('fs');
const path = require('path');

// Use dynamic import for pdf-parse as it's an ES module
let PDFParse;

/**
 * Detect file type based on extension
 * @param {string} filePath - Path to the file
 * @returns {string} - File type: 'pdf', 'csv', 'json', or 'text'
 */
function detectFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    return 'pdf';
  }
  if (ext === '.csv') {
    return 'csv';
  }
  if (ext === '.json') {
    return 'json';
  }
  return 'text';
}

/**
 * Normalize a name/title string for better semantic and keyword match (e.g. "V-Standard plissegardin" vs "V-Standard Up & Down Plissegardin").
 * Structure-agnostic: applied to any name-like or title-like field.
 */
function normalizeForSearch(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\s*\([^)]*\)/g, ' ')
    .replace(/\s*&\s*/g, ' ')
    .replace(/[\s.-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Keys that typically hold a name/title; we add a normalized searchable form for these */
const NAME_LIKE_KEYS = new Set(['name', 'title', 'product_name', 'productname', 'question', 'heading']);

/**
 * Flatten an object into "key: value" parts for a searchable summary line.
 * Fully recursive: works for any JSON depth and structure (products, FAQs, nested configs, etc.).
 * For name/title-like fields, also adds a normalized form so partial names match (e.g. "V-Standard plissegardin").
 */
function flattenToSummaryParts(obj, prefix = '') {
  const parts = [];
  if (!obj || typeof obj !== 'object') return parts;

  const scalar = (v) => v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const label = prefix ? `${prefix}.${key}` : key;
    const keyLower = key.toLowerCase();

    if (Array.isArray(value)) {
      if (value.length > 0) {
        const first = value[0];
        if (scalar(first)) parts.push(`${label}: ${value.join(', ')}`);
        else if (typeof first === 'object') parts.push(`${label}: ${value.map(v => typeof v === 'object' && v !== null ? flattenToSummaryParts(v, label).join('; ') : String(v)).join('; ')}`);
      }
    } else if (typeof value === 'object') {
      parts.push(...flattenToSummaryParts(value, label));
    } else {
      parts.push(`${label}: ${value}`);
      if (typeof value === 'string' && NAME_LIKE_KEYS.has(keyLower)) {
        const norm = normalizeForSearch(value);
        if (norm && norm !== value.toLowerCase()) parts.push(`searchable: ${norm}`);
      }
    }
  }
  return parts;
}

/**
 * Check if JSON structure matches FAQ format (has categories with question/answer items)
 * @param {object} data - Parsed JSON data
 * @returns {boolean} - True if it looks like FAQ structure
 */
function isFAQStructure(data) {
  if (!data || typeof data !== 'object') return false;
  
  // Check if it has a 'categories' property with category objects containing arrays
  if (data.categories && typeof data.categories === 'object') {
    const categoryKeys = Object.keys(data.categories);
    if (categoryKeys.length > 0) {
      // Check if first category has an array of objects with 'question' and 'answer'
      const firstCategory = data.categories[categoryKeys[0]];
      if (Array.isArray(firstCategory) && firstCategory.length > 0) {
        const firstItem = firstCategory[0];
        if (firstItem && typeof firstItem === 'object' && 
            ('question' in firstItem || 'Question' in firstItem) &&
            ('answer' in firstItem || 'Answer' in firstItem)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Parse FAQ JSON structure and convert to searchable text format
 * Formats each FAQ as: "Category: [category]. Question: [question]. Answer: [answer]"
 * @param {object} data - Parsed JSON data with FAQ structure
 * @returns {string} - Formatted text representation
 */
function parseFAQJSON(data) {
  const textItems = [];
  
  if (!data.categories || typeof data.categories !== 'object') {
    return '';
  }
  
  // Process each category
  Object.entries(data.categories).forEach(([categoryName, faqs]) => {
    if (!Array.isArray(faqs)) return;
    
    faqs.forEach((faq) => {
      if (!faq || typeof faq !== 'object') return;
      
      const question = faq.question || faq.Question || '';
      const answer = faq.answer || faq.Answer || '';
      const imageUrl = faq.image_url || faq.imageUrl || '';
      const imageAlt = faq.image_alt || faq.imageAlt || '';
      
      if (!question && !answer) return;
      
      // Format FAQ for optimal searchability
      // Include category context, question, and full answer
      let faqText = `Category: ${categoryName}. Question: ${question}. Answer: ${answer}`;
      if (imageUrl) {
        faqText += `. Image URL: ${imageUrl}`;
        if (imageAlt) {
          faqText += ` (${imageAlt})`;
        }
      }
      textItems.push(faqText);
      
      // Also add a version with just question and answer for direct matching
      if (question && answer) {
        let simpleText = `Question: ${question}. Answer: ${answer}`;
        if (imageUrl) {
          simpleText += `. Image URL: ${imageUrl}`;
        }
        textItems.push(simpleText);
      }
    });
  });
  
  return textItems.join('\n\n');
}

/**
 * Parse JSON file and convert to searchable text format
 * @param {string} filePath - Path to the JSON file
 * @returns {string} - Formatted text representation of JSON data
 */
function parseJSON(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);
    
    // Check if it's FAQ structure and use specialized parser
    if (isFAQStructure(data)) {
      return parseFAQJSON(data);
    }
    
    // Handle different JSON structures (original logic for other JSON types)
    let items = [];
    
    // If it's an array, use it directly
    if (Array.isArray(data)) {
      items = data;
    }
    // If it's an object with an array property (common pattern)
    else if (typeof data === 'object' && data !== null) {
      // Check for common array property names
      const arrayKeys = Object.keys(data).filter(key => Array.isArray(data[key]));
      if (arrayKeys.length > 0) {
        // Use the first array found
        items = data[arrayKeys[0]];
      } else {
        // Single object, wrap in array
        items = [data];
      }
    }
    
    // Convert each item to searchable text format (structure-agnostic: works for products, FAQs, docs, etc.)
    const textItems = items.map((item, index) => {
      if (typeof item === 'string') {
        return item;
      }
      
      if (typeof item === 'object' && item !== null) {
        const summaryParts = flattenToSummaryParts(item);
        const fields = [];
        if (summaryParts.length > 0) {
          fields.push(summaryParts.join('. '));
        }

        // Helper function to format field value
        const formatValue = (val) => {
          if (Array.isArray(val)) {
            if (val.length > 0 && typeof val[0] === 'object') {
              return val.map(obj => {
                if (typeof obj === 'object' && obj !== null) {
                  const objFields = [];
                  Object.entries(obj).forEach(([k, v]) => {
                    if (v !== undefined && v !== null) {
                      if (typeof v === 'object' && !Array.isArray(v)) {
                        objFields.push(`${k}: ${JSON.stringify(v)}`);
                      } else {
                        objFields.push(`${k}: ${v}`);
                      }
                    }
                  });
                  return objFields.length > 0 ? objFields.join(', ') : JSON.stringify(obj);
                }
                return String(obj);
              }).join('; ');
            }
            return val.join(', ');
          } else if (typeof val === 'object' && val !== null) {
            const objFields = [];
            Object.entries(val).forEach(([k, v]) => {
              if (v !== undefined && v !== null) {
                objFields.push(`${k}: ${v}`);
              }
            });
            return objFields.length > 0 ? objFields.join(', ') : JSON.stringify(val);
          }
          return String(val);
        };

        Object.entries(item).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            const formattedValue = formatValue(value);
            fields.push(`${key}: ${formattedValue}`);
          }
        });

        return fields.join(', ');
      }
      
      return String(item);
    });
    
    return textItems.join('\n\n');
  } catch (error) {
    throw new Error(`Failed to parse JSON file: ${error.message}`);
  }
}

/**
 * Parse CSV file and convert to searchable text format
 * @param {string} filePath - Path to the CSV file
 * @returns {string} - Formatted text representation of CSV data
 */
function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  
  if (lines.length === 0) {
    return '';
  }
  
  // Parse header row
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  
  // Parse data rows
  const products = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === 0) continue;
    
    const product = {};
    headers.forEach((header, index) => {
      product[header] = values[index] || '';
    });
    
    // Prioritize Name and SKU for better searchability
    // Create a focused product entry with Name and SKU first, then other important fields
    const name = (product.Name || product.name || '').trim();
    const sku = (product.SKU || product.sku || '').trim();
    const id = (product.ID || product.id || '').trim();
    
    // Create multiple representations for better searchability:
    // 1. Focused entry: Name, SKU, and key fields
    // 2. Full entry: All fields for comprehensive search
    
    // Focused entry (prioritized for search)
    const focusedFields = [];
    if (name) focusedFields.push(`Product Name: ${name}`);
    if (sku) focusedFields.push(`SKU: ${sku}`);
    if (id) focusedFields.push(`Product ID: ${id}`);
    
    // Add other important fields
    const importantFields = ['Type', 'Categories', 'Tags', 'Colour', 'Blind Type', 'Material', 'Features'];
    importantFields.forEach(field => {
      const value = product[field] || product[field.toLowerCase()];
      if (value && String(value).trim()) {
        focusedFields.push(`${field}: ${String(value).trim()}`);
      }
    });
    
    // Create focused product text (this will be more searchable)
    const focusedText = focusedFields.join(', ');
    
    // Also create full product text with all fields for comprehensive search
    const fullProductText = Object.entries(product)
      .filter(([key, value]) => value && value.trim().length > 0)
      .map(([key, value]) => {
        const cleanValue = String(value).replace(/^"|"$/g, '').trim();
        return `${key}: ${cleanValue}`;
      })
      .join(', ');
    
    // Add both representations - focused first (more likely to match), then full
    if (focusedText) {
      products.push(focusedText);
    }
    // Add full text as a separate entry for comprehensive search
    if (fullProductText && fullProductText !== focusedText) {
      products.push(fullProductText);
    }
  }
  
  return products.join('\n\n');
}

/**
 * Parse a CSV line handling quoted values with commas
 * @param {string} line - CSV line
 * @returns {string[]} - Array of values
 */
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  // Add last field
  values.push(current.trim());
  
  return values;
}

async function extractText(filePath) {
  const fileType = detectFileType(filePath);

  try {
    if (fileType === 'pdf') {
      // Lazy load pdf-parse module
      if (!PDFParse) {
        const pdfParseModule = await import('pdf-parse');
        PDFParse = pdfParseModule.default || pdfParseModule.PDFParse || pdfParseModule;
      }

      // Read PDF file
      const dataBuffer = fs.readFileSync(filePath);
      
      // Check if PDFParse is a class or function
      let data;
      if (typeof PDFParse === 'function' && PDFParse.prototype && PDFParse.prototype.constructor === PDFParse) {
        // It's a class, use getText method
        const parser = new PDFParse({ data: dataBuffer });
        const textResult = await parser.getText();
        data = { text: textResult.text || textResult };
      } else {
        // It's a function, call it directly
        data = await PDFParse(dataBuffer);
      }
      
      return cleanText(data.text || data);
    } else if (fileType === 'csv') {
      // Parse CSV file
      const csvText = parseCSV(filePath);
      return cleanText(csvText);
    } else if (fileType === 'json') {
      // Parse JSON file
      const jsonText = parseJSON(filePath);
      // Don't apply cleanText to JSON parsing as it may remove important characters like slashes in URLs
      // Just normalize whitespace
      return jsonText.replace(/\s+/g, ' ').trim();
    } else {
      // Read text file
      const text = fs.readFileSync(filePath, 'utf-8');
      return cleanText(text);
    }
  } catch (error) {
    throw new Error(`Failed to parse file: ${error.message}`);
  }
}

/**
 * Clean and normalize text content
 * @param {string} text - Raw text content
 * @returns {string} - Cleaned text
 */
function cleanText(text) {
  if (!text) {
    return '';
  }

  // Remove excessive whitespace
  let cleaned = text.replace(/\s+/g, ' ');
  
  // Preserve URLs - don't clean text that contains URLs
  // Check if text contains URL patterns (http://, https://)
  const urlPattern = /https?:\/\/[^\s]+/gi;
  const hasUrls = urlPattern.test(cleaned);
  
  if (!hasUrls) {
    // Remove special characters but keep basic punctuation (including slashes for paths)
    // Keep slashes, colons, and other URL-safe characters
    cleaned = cleaned.replace(/[^\w\s.,!?;:()\-'"/]/g, '');
  }
  // If URLs are present, preserve them as-is (don't strip slashes or colons)
  
  // Trim whitespace
  cleaned = cleaned.trim();
  
  return cleaned;
}

module.exports = {
  detectFileType,
  extractText,
  cleanText
};
