const fs = require('fs');
const path = require('path');

// Use dynamic import for pdf-parse as it's an ES module
let PDFParse;

/**
 * Detect file type based on extension
 * @param {string} filePath - Path to the file
 * @returns {string} - File type: 'pdf' or 'text'
 */
function detectFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    return 'pdf';
  }
  return 'text';
}

/**
 * Extract plain text from a file
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} - Extracted text content
 */
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
