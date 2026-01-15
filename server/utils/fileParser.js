const fs = require('fs');
const path = require('path');

// Use dynamic import for pdf-parse as it's an ES module
let PDFParse;

/**
 * Detect file type based on extension
 * @param {string} filePath - Path to the file
 * @returns {string} - File type: 'pdf', 'csv', or 'text'
 */
function detectFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    return 'pdf';
  }
  if (ext === '.csv') {
    return 'csv';
  }
  return 'text';
}

/**
 * Extract plain text from a file
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} - Extracted text content
 */
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
    
    // Format as searchable text: "Product: [Name], SKU: [SKU], Type: [Type], ..."
    const productText = Object.entries(product)
      .filter(([key, value]) => value && value.trim().length > 0)
      .map(([key, value]) => {
        // Clean up value (remove quotes, handle commas in values)
        const cleanValue = String(value).replace(/^"|"$/g, '').trim();
        return `${key}: ${cleanValue}`;
      })
      .join(', ');
    
    products.push(productText);
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
  
  // Remove special characters but keep basic punctuation
  cleaned = cleaned.replace(/[^\w\s.,!?;:()\-'"]/g, '');
  
  // Trim whitespace
  cleaned = cleaned.trim();
  
  return cleaned;
}

module.exports = {
  detectFileType,
  extractText,
  cleanText
};
