import React from 'react';
import './ChatMessage.css';

/**
 * ChatMessage Component
 * Displays individual chat messages (user or assistant)
 */
function ChatMessage({ message, role, isLoading = false }) {
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
        <div className="chat-message-text" dangerouslySetInnerHTML={{ __html: formatMessage(message) }}></div>
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
 * Format message text - convert markdown bold to HTML
 */
function formatMessage(text) {
  if (!text) return '';
  
  // Escape HTML to prevent XSS
  const escapeHtml = (str) => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };
  
  // Escape all HTML first
  let escaped = escapeHtml(text);
  
  // Convert **text** to <strong>text</strong>
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // Convert line breaks to <br>
  escaped = escaped.replace(/\n/g, '<br>');
  
  return escaped;
}

export default ChatMessage;
