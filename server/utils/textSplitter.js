const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');

/**
 * Split text into chunks using RecursiveCharacterTextSplitter
 * @param {string} text - Text to split
 * @returns {Promise<Array>} - Array of document chunks
 */
async function splitText(text) {
  try {
    // Initialize the text splitter with 1000 character chunks and 200 character overlap
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
      separators: ['\n\n', '\n', '. ', ' ', ''], // Split by paragraphs, lines, sentences, words
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
