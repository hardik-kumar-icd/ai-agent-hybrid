/**
 * Script to ingest FAQ JSON file into Pinecone
 * Usage: node server/scripts/ingestFAQs.js [path-to-faq-file]
 * Default: uses visor_faqs.json in project root
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { extractText } = require('../utils/fileParser');
const { splitText } = require('../utils/textSplitter');
const { embedAndStore } = require('../utils/embeddingService');

async function ingestFAQs() {
  try {
    // Get FAQ file path from command line argument or use default
    // Default path: project root/visor_faqs.json
    const defaultPath = path.join(__dirname, '../../visor_faqs.json');
    const faqFilePath = process.argv[2] || defaultPath;
    
    // Check if file exists
    if (!fs.existsSync(faqFilePath)) {
      console.error(`❌ Error: FAQ file not found at: ${faqFilePath}`);
      process.exit(1);
    }

    console.log(`📄 Reading FAQ file: ${faqFilePath}`);
    
    // Step 1: Extract text from FAQ JSON (will use specialized FAQ parser)
    const text = await extractText(faqFilePath);
    
    if (!text || text.trim().length === 0) {
      console.error('❌ Error: No text content found in FAQ file');
      process.exit(1);
    }

    console.log(`✅ Extracted text from FAQ file`);
    console.log(`📊 Text length: ${text.length} characters`);

    // Step 2: Split text into chunks
    console.log(`\n📦 Splitting text into chunks...`);
    const chunks = await splitText(text);
    
    if (!chunks || chunks.length === 0) {
      console.error('❌ Error: Failed to split text into chunks');
      process.exit(1);
    }

    console.log(`✅ Created ${chunks.length} chunks`);

    // Step 3: Create embeddings and store in Pinecone
    const sourceName = path.basename(faqFilePath, '.json');
    console.log(`\n🔮 Creating embeddings and storing in Pinecone...`);
    console.log(`📝 Source name: ${sourceName}`);
    
    await embedAndStore(chunks, sourceName);

    console.log(`\n✅ Successfully ingested ${chunks.length} FAQ chunks into Pinecone!`);
    console.log(`\n🎉 FAQs are now available for the agent to use.`);
    console.log(`\n💡 The agent will automatically use these FAQs when users ask FAQ-related questions.`);

  } catch (error) {
    console.error('❌ Error ingesting FAQs:', error);
    process.exit(1);
  }
}

// Run the ingestion
if (require.main === module) {
  ingestFAQs();
}

module.exports = { ingestFAQs };
