const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');

/**
 * Split text into chunks using RecursiveCharacterTextSplitter
 * @param {string} text - Text to split
 * @returns {Promise<Array>} - Array of document chunks
 */
async function splitText(text) {
  try {
    // Detect if input text is likely product data (contains "Product Name:" and "SKU:")
    // Use larger chunks for product data to keep product entries together
    const isProductData = text.includes('Product Name:') && text.includes('SKU:');
    const chunkSize = isProductData ? 2000 : 1000;
    const chunkOverlap = isProductData ? 300 : 200;
    
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: chunkSize,
      chunkOverlap: chunkOverlap,
      separators: ['\n\n', '\n', '. ', ' ', ''],
    });

    // Split the text into documents
    const documents = await textSplitter.createDocuments([text]);

    return documents;
  } catch (error) {
    throw new Error(`Failed to split text: ${error.message}`);
  }
}

module.exports = {
  splitText
};
