import React from 'react';
import './ChatMessage.css';

/**
 * ChatMessage Component
 * Displays individual chat messages (user or assistant)
 */
function ChatMessage({
  message,
  role,
  isLoading = false,
  guidesButton = false,
  onGuidesClick,
  guidesButtonLabel = 'Åpne veiledninger i ny fane',
  videoEmbeds = null,
  productLinks = null,
}) {
  const isUser = role === 'user';
  
  if (isLoading) {
    return (
      <div className="chat-message chat-message-assistant">
        <div className="chat-message-content">
          <div className="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`chat-message chat-message-${isUser ? 'user' : 'assistant'}`}>
      <div className="chat-message-content">
        {!isUser && (
          <div className="chat-message-avatar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" fill="currentColor"/>
            </svg>
          </div>
        )}
        {!isUser && guidesButton ? (
          <div className="chat-message-assistant-bubble">
            <div
              className="chat-message-text chat-message-text--with-inline-action"
              dangerouslySetInnerHTML={{ __html: formatMessage(message) }}
            />
            <button
              type="button"
              className="chat-message-guides-btn"
              onClick={onGuidesClick}
            >
              {guidesButtonLabel}
            </button>
          </div>
        ) : (
          <div className="chat-message-text">
            <div dangerouslySetInnerHTML={{ __html: formatMessage(message) }} />
            {!isUser && Array.isArray(productLinks) && productLinks.length > 0 && (
              <div className="chat-message-product-links">
                {productLinks.map((p, idx) => (
                  <div key={idx} className="chat-message-product-item">
                    <p className="chat-message-product-item-name">{p.name}</p>
                    {p.sku && <p className="chat-message-product-item-sku">SKU: {p.sku}</p>}
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="chat-message-product-btn"
                    >
                      <span className="chat-message-product-name">{p.buttonLabel || 'Click to view page'}</span>
                      <span className="chat-message-product-arrow">→</span>
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {isUser && (
          <div className="chat-message-avatar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor"/>
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Format message text - convert markdown (bold, links) to HTML
 */
function formatMessage(text) {
  if (!text) return '';

  const escapeHtml = (str) => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  const isSafeUrl = (url) => /^https?:\/\/[^\s<>"']+$/i.test((url || '').trim());

  const parts = [];
  const linkRegex = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  let lastIndex = 0;
  let m;
  while ((m = linkRegex.exec(text)) !== null) {
    parts.push({ type: 'text', value: text.slice(lastIndex, m.index) });
    if (isSafeUrl(m[2])) {
      parts.push({ type: 'link', text: m[1], url: m[2].trim() });
    } else {
      parts.push({ type: 'text', value: `[${m[1]}](${m[2]})` });
    }
    lastIndex = m.index + m[0].length;
  }
  parts.push({ type: 'text', value: text.slice(lastIndex) });

  let out = parts
    .map((p) => {
      if (p.type === 'link') {
        return `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" class="chat-message-link">${escapeHtml(p.text)}</a>`;
      }
      return escapeHtml(p.value);
    })
    .join('');

  out = out.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\n/g, '<br>');

  return out;
}

export default ChatMessage;
