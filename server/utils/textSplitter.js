const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');

/**
 * Split text into chunks using RecursiveCharacterTextSplitter
 * @param {string} text - Text to split
 * @returns {Promise<Array>} - Array of document chunks
 */
async function splitText(text) {
  try {
    // Structure-agnostic: if text looks like multiple records (blocks separated by double newline), use larger chunks
    const blocks = text.split(/\n\n+/);
    const hasStructuredRecords = blocks.length >= 2 && blocks.some(b => /^\s*\w+:\s*.+/.test(b));
    const chunkSize = hasStructuredRecords ? 1800 : 1200;
    const chunkOverlap = hasStructuredRecords ? 400 : 250;
    
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
