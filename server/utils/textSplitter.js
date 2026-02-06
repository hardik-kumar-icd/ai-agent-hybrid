const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');

/** Max size for a single record block to be kept as one chunk (any structure) */
const MAX_RECORD_CHUNK_CHARS = 4000;

/**
 * Split text into chunks. Keeps each logical record (block separated by double newline) in one chunk when under size limit, so any JSON structure stays self-contained.
 * @param {string} text - Text to split
 * @returns {Promise<Array>} - Array of document chunks (objects with pageContent)
 */
async function splitText(text) {
  try {
    const blocks = text.split(/\n\n+/).filter(b => b.trim().length > 0);
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1500,
      chunkOverlap: 300,
      separators: ['\n\n', '\n', '. ', ' ', ''],
    });

    const documents = [];
    for (const block of blocks.length > 0 ? blocks : [text]) {
      const content = block.trim();
      if (!content) continue;
      if (content.length <= MAX_RECORD_CHUNK_CHARS) {
        documents.push({ pageContent: content });
      } else {
        const subDocs = await textSplitter.createDocuments([content]);
        documents.push(...subDocs);
      }
    }
    return documents;
  } catch (error) {
    throw new Error(`Failed to split text: ${error.message}`);
  }
}

module.exports = {
  splitText
};
