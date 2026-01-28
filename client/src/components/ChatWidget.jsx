import React, { useState, useEffect, useRef } from 'react';
import ChatMessage from './ChatMessage';
import AdminPanel from './AdminPanel';
import './ChatWidget.css';

/**
 * ChatWidget Component
 * Main chat widget that can be embedded on WordPress/Magento sites
 * Supports both 'user' and 'admin' modes
 */
function ChatWidget({ baseUrl, themeColor, accentColor, mode = 'user', adminToken }) {
  const isAdmin = mode === 'admin';
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Set CSS variables for theming
  useEffect(() => {
    if (themeColor) {
      document.documentElement.style.setProperty('--widget-primary-color', themeColor);
    }
    if (accentColor) {
      document.documentElement.style.setProperty('--widget-accent-color', accentColor);
    }
  }, [themeColor, accentColor]);

  // Load conversationId from localStorage on mount
  useEffect(() => {
    const savedConversationId = localStorage.getItem('visor_conversation_id');
    if (savedConversationId) {
      setConversationId(savedConversationId);
    } else {
      // Generate new conversationId
      const newId = 'conv-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      setConversationId(newId);
      localStorage.setItem('visor_conversation_id', newId);
    }

    // Load last few messages from sessionStorage
    const savedMessages = sessionStorage.getItem('visor_chat_messages');
    if (savedMessages) {
      try {
        setMessages(JSON.parse(savedMessages));
      } catch (e) {
        console.error('Failed to load saved messages:', e);
      }
    }
  }, []);

  // Save messages to sessionStorage
  useEffect(() => {
    if (messages.length > 0) {
      // Keep only last 10 messages
      const recentMessages = messages.slice(-10);
      sessionStorage.setItem('visor_chat_messages', JSON.stringify(recentMessages));
    }
  }, [messages]);

  // Auto-scroll to bottom when new message arrives
  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  // Focus input when chat opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const sendMessage = async () => {
    const message = inputValue.trim();
    if (!message || isLoading) return;

    // Add user message to UI immediately
    const userMessage = { role: 'user', content: message };
    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);
    setError(null);

    try {
      const apiBaseUrl = baseUrl || 'https://ai-agent-hybrid.onrender.com';
      const response = await fetch(`${apiBaseUrl}/visor-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Conversation-Id': conversationId
        },
        body: JSON.stringify({
          message: message,
          conversationId: conversationId
        })
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Session expired. Please refresh the page.');
        } else if (response.status === 429) {
          throw new Error('Too many requests. Please wait a moment and try again.');
        } else {
          throw new Error(`Server error: ${response.status}`);
        }
      }

      const data = await response.json();
      const assistantMessage = { role: 'assistant', content: data.reply || 'No response received.' };
      setMessages(prev => [...prev, assistantMessage]);

    } catch (error) {
      console.error('Chat error:', error);
      setError(error.message || 'Failed to send message. Please try again.');
      // Remove the user message if there was an error
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleToggle = () => {
    setIsOpen(!isOpen);
  };

  return (
    <div className="visor-chat-widget">
      {/* Chat Window / Admin Panel */}
      {isOpen && (
        <div className="chat-window">
          {isAdmin ? (
            // Admin Mode: Show Admin Panel
            <>
              <div className="chat-window-header">
                <div className="chat-header-content">
                  <div className="chat-header-text">
                    <h3>Admin Panel</h3>
                    <p>Knowledge Base Management</p>
                  </div>
                </div>
                <button className="chat-close-button" onClick={handleToggle} aria-label="Close admin panel">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
                  </svg>
                </button>
              </div>
              <AdminPanel baseUrl={baseUrl} adminToken={adminToken} />
            </>
          ) : (
            // User Mode: Show Chat Interface
            <>
              <div className="chat-window-header">
                <div className="chat-header-content">
                  <div className="chat-header-avatar">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" fill="currentColor"/>
                    </svg>
                  </div>
                  <div className="chat-header-text">
                    <h3>Visor.no Assistant</h3>
                    <p>How can I help you today?</p>
                  </div>
                </div>
                <button className="chat-close-button" onClick={handleToggle} aria-label="Close chat">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
                  </svg>
                </button>
              </div>

              <div className="chat-messages">
                {messages.length === 0 && (
                  <div className="chat-welcome-message">
                    <p>Hei! Jeg er Visor.no assistenten. Hvordan kan jeg hjelpe deg?</p>
                  </div>
                )}
                {messages.map((msg, idx) => (
                  <ChatMessage key={idx} message={msg.content} role={msg.role} />
                ))}
                {isLoading && <ChatMessage message="" role="assistant" isLoading={true} />}
                {error && (
                  <div className="chat-error-message">
                    <p>{error}</p>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="chat-input-container">
                <input
                  ref={inputRef}
                  type="text"
                  className="chat-input"
                  placeholder="Skriv din melding her..."
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyPress={handleKeyPress}
                  disabled={isLoading}
                />
                <button
                  className="chat-send-button"
                  onClick={sendMessage}
                  disabled={!inputValue.trim() || isLoading}
                  aria-label="Send message"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/>
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Chat Button */}
      <button
        className="chat-button"
        onClick={handleToggle}
        aria-label="Open chat"
        aria-expanded={isOpen}
      >
        {isOpen ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" fill="currentColor"/>
          </svg>
        )}
      </button>
    </div>
  );
}

export default ChatWidget;
