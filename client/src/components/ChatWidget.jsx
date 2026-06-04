import React, { useState, useEffect, useRef } from 'react';
import ChatMessage from './ChatMessage';
import AdminPanel from './AdminPanel';
import './ChatWidget.css';

/**
 * ChatWidget Component
 * Main chat widget that can be embedded on WordPress/Magento sites
 * Supports both 'user' and 'admin' modes
 */
const WELCOME_MESSAGE = 'Hei! Jeg er din assistent på visor.no. Velg en kategori eller skriv spørsmålet ditt nedenfor, så skal jeg hjelpe deg så godt som mulig.';
/** Veiledninger (måling / montering) — same CMS page customers use on the shop */
const GUIDES_PAGE_URL = 'https://test.visor.no/how-to-install/';
const ENGLISH_PLACEHOLDER = 'Type your message here...';
const NORWEGIAN_PLACEHOLDER = 'Skriv din melding her...';
const ENGLISH_DETECT_REGEX = /\b(what|how|order|status|the|is|can|do|does|please|help|want|need|hello|hi|when|where|which|why|tell|me|about)\b/i;
const ORDER_DETECT_REGEX = /\b(ordrestatus|order status|where is my order|hvor er min ordre|track order|spor ordre|order number|ordrenummer|order id|orderid)\b/i;

/**
 * Stream a chat response via Server-Sent Events.
 * Throws on any error so the caller can fall back to /visor-chat.
 *
 * @param {string} apiBaseUrl - e.g. https://agent.visor.no
 * @param {object} payload - { message, conversationId, email?, order_id? }
 * @param {string} conversationId
 * @param {(token: string) => void} onToken - called for each streamed token
 * @returns {Promise<{messageId: string|null, fullText: string}>}
 */
async function streamChat(apiBaseUrl, payload, conversationId, onToken) {
  const response = await fetch(`${apiBaseUrl}/visor-chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'X-Conversation-Id': conversationId,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = new Error(`Stream failed: ${response.status}`);
    err.status = response.status;
    throw err;
  }

  // Some proxies don't pass SSE through correctly. Fall back if so.
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    throw new Error('Server did not respond with text/event-stream');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let messageId = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by blank lines (\n\n)
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const dataLine = rawEvent
        .split('\n')
        .find((line) => line.startsWith('data:'));
      if (!dataLine) continue;

      const payloadStr = dataLine.slice(5).trim();
      if (!payloadStr) continue;

      let evt;
      try {
        evt = JSON.parse(payloadStr);
      } catch (_) {
        continue;
      }

      if (evt.type === 'meta') {
        messageId = evt.messageId;
      } else if (evt.type === 'token') {
        fullText += evt.content || '';
        onToken(evt.content || '');
      } else if (evt.type === 'done') {
        fullText = evt.content || fullText;
        messageId = evt.messageId || messageId;
      } else if (evt.type === 'error') {
        throw new Error(evt.message || 'Server streaming error');
      }
    }
  }

  return { messageId, fullText };
}

function ChatWidget({ baseUrl, themeColor, accentColor, mode = 'user', adminToken }) {
  const isAdmin = mode === 'admin';
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [conversationLanguage, setConversationLanguage] = useState('nb');
  const [selectedOption, setSelectedOption] = useState(null);
  const [orderEmail, setOrderEmail] = useState('');
  const [orderId, setOrderId] = useState('');
  const [showOptionsAgain, setShowOptionsAgain] = useState(false);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const lastMessageRef = useRef(null);

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

  // Auto-scroll to show latest message when new message arrives
  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => {
      // If options are about to show, scroll to last message instead of bottom
      if (showOptionsAgain) {
        if (lastMessageRef.current) {
          lastMessageRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
      } else {
        scrollToBottom();
      }
    }, 150);
    return () => clearTimeout(t);
  }, [messages, isLoading, isOpen, showOptionsAgain]);

  // Delay showing options after order response to let user read the message first.
  // Also reset the expanded state so the capsule starts collapsed each time
  // options reappear (PR #16).
  useEffect(() => {
    if (!showOptionsAgain) {
      setOptionsExpanded(false);
    }
  }, [showOptionsAgain]);

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

    // Detect English from first user message for placeholder language
    setConversationLanguage(prev => (prev === 'nb' && ENGLISH_DETECT_REGEX.test(message) ? 'en' : prev));

    // If user is asking about order status, show the form only – don't call API (no typing indicator, form usable immediately)
    if (ORDER_DETECT_REGEX.test(message)) {
      setSelectedOption('order');
      setShowOptionsAgain(false);
      const userMessage = { role: 'user', content: message };
      setMessages(prev => [...prev, userMessage]);
      setInputValue('');
      return;
    }

    const userMessage = { role: 'user', content: message };
    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);
    setError(null);

    try {
      const apiBaseUrl = baseUrl || 'https://agent.visor.no';

      // Append empty assistant message we'll fill with streamed tokens
      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      const onToken = (token) => {
        setMessages(prev => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === 'assistant') {
            next[next.length - 1] = { ...last, content: (last.content || '') + token };
          }
          return next;
        });
      };

      let streamed = false;
      try {
        const { fullText } = await streamChat(
          apiBaseUrl,
          { message: message, conversationId: conversationId },
          conversationId,
          onToken
        );
        streamed = true;
        // Replace partial content with server-authoritative full text
        setMessages(prev => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === 'assistant') {
            next[next.length - 1] = { ...last, content: fullText };
          }
          return next;
        });
      } catch (streamErr) {
        console.warn('[Visor] streaming failed, falling back to /visor-chat:', streamErr.message);
        // Remove the empty assistant placeholder before fallback
        setMessages(prev => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.role === 'assistant' && !last.content) {
            return prev.slice(0, -1);
          }
          return prev;
        });
      }

      if (!streamed) {
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
      }

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

  const handleRestartChat = () => {
    setMessages([]);
    setError(null);
    setConversationLanguage('nb');
    setSelectedOption(null);
    setOrderEmail('');
    setOrderId('');
    setShowOptionsAgain(false);
    const newId = 'conv-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    setConversationId(newId);
    localStorage.setItem('visor_conversation_id', newId);
    sessionStorage.removeItem('visor_chat_messages');
  };

  const handleOptionSelect = (option) => {
    setSelectedOption(option);
    if (option === 'order') {
      // For order status, we'll show the form inputs
      setMessages(prev => [...prev, { role: 'user', content: 'Order Status' }]);
    } else if (option === 'install_guides') {
      const label = conversationLanguage === 'en'
        ? 'Installation guides'
        : 'Monteringsveiledninger';
      const prompt =
        conversationLanguage === 'en'
          ? 'Enter your order number and email, and I will show the relevant installation videos for the products in your order.'
          : 'Skriv inn ordrenummer og e-postadressen brukt i bestillingen, så viser jeg relevante monteringsvideoer for produktene i ordren din.';
      setMessages(prev => [...prev, { role: 'user', content: label }]);
      setMessages(prev => [...prev, { role: 'assistant', content: prompt }]);
    } else if (option === 'faqs') {
      setMessages(prev => [...prev, { role: 'user', content: 'FAQs' }]);
      const promptMessage = conversationLanguage === 'en'
        ? 'Enter your query'
        : 'Skriv inn spørsmålet ditt';
      setMessages(prev => [...prev, { role: 'assistant', content: promptMessage }]);
    } else if (option === 'product') {
      setMessages(prev => [...prev, { role: 'user', content: 'Product Info' }]);
      const promptMessage = conversationLanguage === 'en'
        ? 'Enter your product related query'
        : 'Skriv inn produktrelatert spørsmål';
      setMessages(prev => [...prev, { role: 'assistant', content: promptMessage }]);
    } else if (option === 'guides') {
      const userLabel = conversationLanguage === 'en' ? 'How do I order?' : 'Hvordan bestiller jeg?';
      const intro =
        conversationLanguage === 'en'
          ? `Ordering is done in our online store like any other purchase. For **measuring** and **installing** your products, we have collected videos and step-by-step guides on one page.`
          : `Bestilling skjer i nettbutikken som vanlig. For **måling** og **montering** har vi samlet videoer og steg-for-steg-veiledning på én side.`;
      setMessages(prev => [...prev, { role: 'user', content: userLabel }]);
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: intro, guidesButton: true },
      ]);
    }
  };

  const openGuidesInNewTab = () => {
    window.open(GUIDES_PAGE_URL, '_blank', 'noopener,noreferrer');
  };

  const toSafeEmbedSrc = (url) => {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();

      // YouTube: convert watch?v= -> /embed/
      if (host === 'www.youtube.com' || host === 'youtube.com') {
        if (u.pathname === '/watch') {
          const v = u.searchParams.get('v');
          if (v) return `https://www.youtube.com/embed/${encodeURIComponent(v)}`;
        }
        if (u.pathname.startsWith('/embed/')) return u.toString();
      }
      if (host === 'youtu.be') {
        const id = u.pathname.replace('/', '').trim();
        if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}`;
      }

      // Vimeo: accept vimeo.com/{id} -> player.vimeo.com/video/{id}
      if (host === 'vimeo.com') {
        const id = u.pathname.replace('/', '').trim();
        if (/^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
      }
      if (host === 'player.vimeo.com' && u.pathname.startsWith('/video/')) return u.toString();

      return null;
    } catch {
      return null;
    }
  };

  const handleInstallGuidesSubmit = async () => {
    if (!orderEmail.trim() || !orderId.trim()) {
      setError(conversationLanguage === 'en'
        ? 'Please fill in both email and order ID'
        : 'Vennligst fyll inn både e-post og ordrenummer');
      return;
    }

    const emailValue = orderEmail.trim();
    const orderIdValue = orderId.trim();
    const userMessage =
      conversationLanguage === 'en'
        ? `Get installation videos for Order ID: ${orderIdValue}`
        : `Hent monteringsvideoer for ordrenummer: ${orderIdValue}`;

    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);
    setError(null);

    try {
      const apiBaseUrl = baseUrl || 'https://agent.visor.no';
      const response = await fetch(`${apiBaseUrl}/api/order/install-guides`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Conversation-Id': conversationId,
        },
        body: JSON.stringify({
          order_id: orderIdValue,
          email: emailValue,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || `Server error: ${response.status}`);
      }

      const data = await response.json();

      const productLinks = (data.videos || [])
        .map((v) => {
          const name = (v.product?.name || v.title || '').trim();
          const sku = (v.product?.sku || '').trim();
          const productUrl = (v.product?.product_url || '').trim();
          if (!productUrl) return null;
          const buttonLabel = conversationLanguage === 'en' ? 'Click to view page' : 'Klikk for å se siden';
          return { name, sku, url: productUrl + '#howto', buttonLabel };
        })
        .filter(Boolean);

      const assistantText =
        productLinks.length > 0
          ? (conversationLanguage === 'en'
            ? 'Here are your ordered products:'
            : 'Her er produktene i ordren din:')
          : (conversationLanguage === 'en'
            ? 'I found your order, but could not find product page links.'
            : 'Jeg fant ordren, men kunne ikke finne produktsidelenker.');

      const followUpText =
        conversationLanguage === 'en'
          ? 'How can I help you further?'
          : 'Hvordan kan jeg hjelpe deg videre?';

      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: assistantText, productLinks },
        { role: 'assistant', content: followUpText }
      ]);

      setOrderEmail('');
      setOrderId('');
      setSelectedOption(null);

      setTimeout(() => {
        setShowOptionsAgain(true);
        setTimeout(() => {
          if (lastMessageRef.current) {
            lastMessageRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
          }
        }, 100);
      }, 2000);
    } catch (error) {
      console.error('Install videos error:', error);
      setError(error.message || 'Failed to fetch installation videos. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOrderSubmit = async () => {
    if (!orderEmail.trim() || !orderId.trim()) {
      setError(conversationLanguage === 'en'
        ? 'Please fill in both email and order ID'
        : 'Vennligst fyll inn både e-post og ordrenummer');
      return;
    }

    const emailValue = orderEmail.trim();
    const orderIdValue = orderId.trim();
    const orderMessage = conversationLanguage === 'en'
      ? `Check order status for Order ID: ${orderIdValue}, Email: ${emailValue}`
      : `Sjekk ordrestatus for ordrenummer: ${orderIdValue}, E-post: ${emailValue}`;

    setMessages(prev => [...prev, { role: 'user', content: orderMessage }]);
    setIsLoading(true);
    setError(null);

    try {
      const apiBaseUrl = baseUrl || 'https://agent.visor.no';

      // Append empty assistant message we'll fill with streamed tokens
      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      const onToken = (token) => {
        setMessages(prev => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === 'assistant') {
            next[next.length - 1] = { ...last, content: (last.content || '') + token };
          }
          return next;
        });
      };

      let streamed = false;
      try {
        const { fullText } = await streamChat(
          apiBaseUrl,
          {
            message: orderMessage,
            conversationId: conversationId,
            email: emailValue,
            order_id: orderIdValue,
            category: 'order'
          },
          conversationId,
          onToken
        );
        streamed = true;
        setMessages(prev => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === 'assistant') {
            next[next.length - 1] = { ...last, content: fullText };
          }
          return next;
        });
      } catch (streamErr) {
        console.warn('[Visor] streaming failed, falling back to /visor-chat:', streamErr.message);
        setMessages(prev => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.role === 'assistant' && !last.content) {
            return prev.slice(0, -1);
          }
          return prev;
        });
      }

      if (!streamed) {
        const response = await fetch(`${apiBaseUrl}/visor-chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Conversation-Id': conversationId
          },
          body: JSON.stringify({
            message: orderMessage,
            conversationId: conversationId,
            email: emailValue,
            order_id: orderIdValue,
            category: 'order'
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
      }

      setOrderEmail('');
      setOrderId('');
      setSelectedOption(null); // Clear order form after submission

      // Delay showing options to let user read the response first
      setTimeout(() => {
        setShowOptionsAgain(true);
        // Scroll to show the response message, not all the way to bottom
        setTimeout(() => {
          if (lastMessageRef.current) {
            lastMessageRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
          }
        }, 100);
      }, 2000); // Show options after 2 seconds

    } catch (error) {
      console.error('Chat error:', error);
      setError(error.message || 'Failed to send message. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadTranscript = () => {
    const displayMessages = messages.length === 0
      ? [{ role: 'assistant', content: WELCOME_MESSAGE }]
      : messages;
    const lines = displayMessages.map(m => {
      const who = m.role === 'user' ? 'You' : 'Assistant';
      return `${who}: ${(m.content || '').replace(/\n/g, ' ')}`;
    });
    const text = lines.join('\n\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `visor-chat-transcript-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
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
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor" />
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
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" fill="currentColor" />
                    </svg>
                  </div>
                  <div className="chat-header-text">
                    <h3>Visor.no Assistant</h3>
                  </div>
                </div>
                <div className="chat-header-right-group">
                  <div className="chat-header-actions">
                    <button type="button" className="chat-header-icon-btn" onClick={handleDownloadTranscript} title="Download transcript" aria-label="Download transcript">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor" />
                      </svg>
                    </button>
                    <button type="button" className="chat-header-icon-btn" onClick={handleRestartChat} title="Restart chat" aria-label="Restart chat">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor" />
                      </svg>
                    </button>
                  </div>
                  <button className="chat-close-button" onClick={handleToggle} aria-label="Close chat">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="chat-messages">
                {messages.length === 0 && (
                  <>
                    <ChatMessage message={WELCOME_MESSAGE} role="assistant" />
                    {!selectedOption && !showOptionsAgain && (
                      <div className="chat-options-container">
                        <p className="chat-options-prompt">
                          {conversationLanguage === 'en'
                            ? 'Please select an option:'
                            : 'Vennligst velg et alternativ:'}
                        </p>
                        <div className="chat-options-buttons">
                          <button
                            className="chat-option-btn"
                            onClick={() => handleOptionSelect('faqs')}
                          >
                            {conversationLanguage === 'en'
                              ? 'FAQs, frequently asked questions and answers'
                              : 'FAQs, stilte spørsmål og svar'}
                          </button>
                          <button
                            className="chat-option-btn"
                            onClick={() => handleOptionSelect('product')}
                          >
                            {conversationLanguage === 'en' ? 'Product Info' : 'Produktinfo'}
                          </button>
                          <button
                            className="chat-option-btn"
                            onClick={() => handleOptionSelect('order')}
                          >
                            {conversationLanguage === 'en' ? 'Order Status' : 'Ordrestatus'}
                          </button>
                          <button
                            className="chat-option-btn"
                            onClick={() => handleOptionSelect('install_guides')}
                          >
                            {conversationLanguage === 'en'
                              ? 'Installation guides'
                              : 'Monteringsveiledninger'}
                          </button>
                          <button
                            className="chat-option-btn"
                            onClick={() => handleOptionSelect('guides')}
                          >
                            {conversationLanguage === 'en' ? 'How to order' : 'Slik bestiller du'}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {messages.map((msg, idx) => {
                  const isLastAssistantMessage = idx === messages.length - 1 && msg.role === 'assistant';
                  return (
                    <div key={idx} ref={isLastAssistantMessage ? lastMessageRef : null}>
                      <ChatMessage
                        message={msg.content}
                        role={msg.role}
                        guidesButton={Boolean(msg.guidesButton)}
                        onGuidesClick={openGuidesInNewTab}
                        guidesButtonLabel={
                          conversationLanguage === 'en'
                            ? 'Open guides in new tab'
                            : 'Åpne veiledninger i ny fane'
                        }
                        videoEmbeds={msg.videoEmbeds || null}
                        productLinks={msg.productLinks || null}
                      />
                    </div>
                  );
                })}
                {showOptionsAgain && !selectedOption && (
                  <>
                    {!optionsExpanded ? (
                      <div className="chat-options-trigger">
                        <button
                          className="chat-options-capsule"
                          onClick={() => setOptionsExpanded(true)}
                          aria-expanded="false"
                          aria-label={conversationLanguage === 'en' ? 'Show options' : 'Vis alternativer'}
                        >
                          <span className="chat-options-capsule-text">
                            {conversationLanguage === 'en' ? 'Show options' : 'Vis alternativer'}
                          </span>
                          <span className="chat-options-capsule-chevron" aria-hidden="true">▾</span>
                        </button>
                      </div>
                    ) : (
                      <div className="chat-options-container compact expanded">
                        <p className="chat-options-prompt">
                          {conversationLanguage === 'en'
                            ? 'Please select an option:'
                            : 'Vennligst velg et alternativ:'}
                        </p>
                        <div className="chat-options-buttons">
                          <button
                            className="chat-option-btn"
                            onClick={() => handleOptionSelect('faqs')}
                          >
                            {conversationLanguage === 'en'
                              ? 'FAQs, frequently asked questions and answers'
                              : 'FAQs, stilte spørsmål og svar'}
                          </button>
                          <button
                            className="chat-option-btn"
                            onClick={() => handleOptionSelect('product')}
                          >
                            {conversationLanguage === 'en' ? 'Product Info' : 'Produktinfo'}
                          </button>
                          <button
                            className="chat-option-btn"
                            onClick={() => handleOptionSelect('order')}
                          >
                            {conversationLanguage === 'en' ? 'Order Status' : 'Ordrestatus'}
                          </button>
                          <button
                            className="chat-option-btn"
                            onClick={() => handleOptionSelect('install_guides')}
                          >
                            {conversationLanguage === 'en'
                              ? 'Installation guides'
                              : 'Monteringsveiledninger'}
                          </button>
                          <button
                            className="chat-option-btn"
                            onClick={() => handleOptionSelect('guides')}
                          >
                            {conversationLanguage === 'en' ? 'How to order' : 'Slik bestiller du'}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {(selectedOption === 'order' || selectedOption === 'install_guides') && messages.length > 0 && (
                  <div className="chat-order-form">
                    <div className="chat-order-form-field">
                      <label>
                        {conversationLanguage === 'en' ? 'Email:' : 'E-post:'}
                      </label>
                      <input
                        type="email"
                        value={orderEmail}
                        onChange={(e) => setOrderEmail(e.target.value)}
                        placeholder={conversationLanguage === 'en' ? 'your@email.com' : 'din@epost.no'}
                        disabled={isLoading}
                      />
                    </div>
                    <div className="chat-order-form-field">
                      <label>
                        {conversationLanguage === 'en' ? 'Order ID:' : 'Ordrenummer:'}
                      </label>
                      <input
                        type="text"
                        value={orderId}
                        onChange={(e) => setOrderId(e.target.value)}
                        placeholder={conversationLanguage === 'en' ? 'Enter order number' : 'Skriv inn ordrenummer'}
                        disabled={isLoading}
                        onKeyPress={(e) => {
                          if (e.key === 'Enter' && orderEmail.trim() && orderId.trim()) {
                            handleOrderSubmit();
                          }
                        }}
                      />
                    </div>
                    <button
                      className="chat-order-submit-btn"
                      onClick={selectedOption === 'order' ? handleOrderSubmit : handleInstallGuidesSubmit}
                      disabled={!orderEmail.trim() || !orderId.trim() || isLoading}
                    >
                      {selectedOption === 'order'
                        ? (conversationLanguage === 'en' ? 'Check Status' : 'Sjekk status')
                        : (conversationLanguage === 'en' ? 'View Installation Guide' : 'Se monteringsveiledning')}
                    </button>
                  </div>
                )}
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
                  placeholder={conversationLanguage === 'en' ? ENGLISH_PLACEHOLDER : NORWEGIAN_PLACEHOLDER}
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
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor" />
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
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" fill="currentColor" />
          </svg>
        )}
      </button>
    </div>
  );
}

export default ChatWidget;