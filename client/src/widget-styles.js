/**
 * Widget CSS Styles
 * Injected programmatically to ensure styles are always available
 */

export const widgetStyles = `
:root {
  --widget-primary-color: #667eea;
  --widget-accent-color: #764ba2;
  --widget-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.visor-chat-widget {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 9999;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}

/* Chat Button */
.chat-button {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--widget-primary-color) 0%, var(--widget-accent-color) 100%);
  border: none;
  color: white;
  cursor: pointer;
  box-shadow: var(--widget-shadow);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  position: relative;
}

.chat-button:hover {
  transform: scale(1.1);
  box-shadow: 0 6px 25px rgba(0, 0, 0, 0.2);
}

.chat-button:active {
  transform: scale(0.95);
}

.chat-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Chat Window */
.chat-window {
  position: absolute;
  bottom: 80px;
  right: 0;
  width: 380px;
  max-width: calc(100vw - 40px);
  height: 600px;
  max-height: calc(100vh - 100px);
  background: white;
  border-radius: 16px;
  box-shadow: var(--widget-shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slideUp 0.3s ease-out;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Chat Header */
.chat-window-header {
  background: linear-gradient(135deg, var(--widget-primary-color) 0%, var(--widget-accent-color) 100%);
  color: white;
  padding: 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.chat-header-content {
  display: flex;
  align-items: center;
  gap: 12px;
}

.chat-header-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-header-text h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.chat-header-text p {
  margin: 4px 0 0 0;
  font-size: 12px;
  opacity: 0.9;
}

.chat-close-button {
  background: rgba(255, 255, 255, 0.2);
  border: none;
  color: white;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.chat-close-button:hover {
  background: rgba(255, 255, 255, 0.3);
}

/* Chat Messages Area */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  background: #f8f9fa;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-messages::-webkit-scrollbar {
  width: 6px;
}

.chat-messages::-webkit-scrollbar-track {
  background: #f1f1f1;
}

.chat-messages::-webkit-scrollbar-thumb {
  background: #c1c1c1;
  border-radius: 3px;
}

.chat-messages::-webkit-scrollbar-thumb:hover {
  background: #a8a8a8;
}

.chat-welcome-message {
  text-align: left;
  padding: 20px;
  color: #666;
  font-size: 14px;
}

.chat-error-message {
  background: #fee;
  color: #c33;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 13px;
  margin: 8px 0;
}

/* Chat Input */
.chat-input-container {
  display: flex;
  gap: 8px;
  padding: 15px;
  background: white;
  border-top: 1px solid #e9ecef;
}

.chat-input {
  flex: 1;
  padding: 12px 16px;
  border: 2px solid #e9ecef;
  border-radius: 24px;
  font-size: 14px;
  outline: none;
  transition: all 0.3s ease;
  font-family: inherit;
}

.chat-input:focus {
  border-color: var(--widget-primary-color);
  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
}

.chat-input:disabled {
  background: #f5f5f5;
  cursor: not-allowed;
}

.chat-send-button {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--widget-primary-color) 0%, var(--widget-accent-color) 100%);
  border: none;
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  box-shadow: 0 2px 10px rgba(102, 126, 234, 0.3);
}

.chat-send-button:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
}

.chat-send-button:active:not(:disabled) {
  transform: translateY(0);
}

.chat-send-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

/* Chat Message Styles */
.chat-message {
  display: flex;
  margin-bottom: 12px;
  animation: fadeIn 0.3s ease-in;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.chat-message-user {
  justify-content: flex-end;
}

.chat-message-assistant {
  justify-content: flex-start;
}

.chat-message-content {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 75%;
}

.chat-message-user .chat-message-content {
  flex-direction: row-reverse;
}

.chat-message-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--widget-primary-color, #667eea);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: white;
}

.chat-message-user .chat-message-avatar {
  background: var(--widget-accent-color, #764ba2);
}

.chat-message-text {
  padding: 12px 16px;
  border-radius: 18px;
  word-wrap: break-word;
  line-height: 1.5;
  font-size: 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  text-align: left;
}

.chat-message-user .chat-message-text {
  background: linear-gradient(135deg, var(--widget-primary-color, #667eea) 0%, var(--widget-accent-color, #764ba2) 100%);
  color: white;
  border-bottom-right-radius: 4px;
}

.chat-message-assistant .chat-message-text {
  background: #f0f0f0;
  color: #333;
  border-bottom-left-radius: 4px;
}

.chat-message-text strong {
  font-weight: 600;
}

.typing-indicator {
  display: inline-flex;
  gap: 4px;
  padding: 12px 16px;
  background: #e9ecef;
  border-radius: 18px;
  border-bottom-left-radius: 4px;
}

.typing-indicator span {
  width: 8px;
  height: 8px;
  background: var(--widget-primary-color, #667eea);
  border-radius: 50%;
  animation: bounce 1.4s infinite ease-in-out both;
}

.typing-indicator span:nth-child(1) {
  animation-delay: -0.32s;
}

.typing-indicator span:nth-child(2) {
  animation-delay: -0.16s;
}

@keyframes bounce {
  0%, 80%, 100% {
    transform: scale(0);
  }
  40% {
    transform: scale(1);
  }
}

/* Admin Panel Styles */
.admin-panel {
  width: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #f8f9fa;
  overflow: hidden;
  min-height: 0;
}

.admin-panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.admin-section {
  background: white;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.admin-section h3 {
  margin: 0 0 16px 0;
  font-size: 16px;
  font-weight: 600;
  color: #333;
}

.admin-upload-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.admin-file-input {
  padding: 12px;
  border: 2px dashed #e9ecef;
  border-radius: 8px;
  background: #f8f9fa;
  cursor: pointer;
  transition: all 0.3s ease;
}

.admin-file-input:hover:not(:disabled) {
  border-color: var(--widget-primary-color, #667eea);
  background: #fff;
}

.admin-file-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.admin-file-list {
  min-height: 60px;
  max-height: 150px;
  overflow-y: auto;
  padding: 12px;
  background: #f8f9fa;
  border-radius: 6px;
}

.admin-file-list ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.admin-file-list li {
  padding: 6px 0;
  font-size: 13px;
  color: #666;
  border-bottom: 1px solid #e9ecef;
}

.admin-file-list li:last-child {
  border-bottom: none;
}

.admin-file-placeholder {
  margin: 0;
  color: #999;
  font-size: 13px;
  font-style: italic;
}

.admin-upload-button {
  padding: 12px 24px;
  background: linear-gradient(135deg, var(--widget-primary-color, #667eea) 0%, var(--widget-accent-color, #764ba2) 100%);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
}

.admin-upload-button:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

.admin-upload-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.admin-log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.admin-log-header h3 {
  margin: 0;
}

.admin-clear-button {
  padding: 6px 12px;
  background: #e9ecef;
  color: #666;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s;
}

.admin-clear-button:hover {
  background: #dee2e6;
}

.admin-log-area {
  min-height: 100px;
  max-height: 200px;
  overflow-y: auto;
  padding: 12px;
  background: #f8f9fa;
  border-radius: 6px;
  border: 1px solid #e9ecef;
}

.admin-log-placeholder {
  margin: 0;
  color: #999;
  font-size: 13px;
  font-style: italic;
  text-align: center;
  padding: 20px 0;
}

.admin-log-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.admin-log-entry {
  padding: 8px 0;
  font-size: 12px;
  display: flex;
  gap: 12px;
  border-bottom: 1px solid #e9ecef;
}

.admin-log-entry:last-child {
  border-bottom: none;
}

.admin-log-time {
  color: #999;
  font-family: 'Courier New', monospace;
  flex-shrink: 0;
  min-width: 80px;
}

.admin-log-message {
  flex: 1;
}

.admin-log-success {
  color: #28a745;
}

.admin-log-error {
  color: #dc3545;
}

.admin-test-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.admin-test-input {
  width: 100%;
  padding: 12px;
  border: 2px solid #e9ecef;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  resize: vertical;
  outline: none;
  transition: border-color 0.3s;
}

.admin-test-input:focus {
  border-color: var(--widget-primary-color, #667eea);
}

.admin-test-input:disabled {
  background: #f5f5f5;
  cursor: not-allowed;
}

.admin-test-button {
  padding: 10px 20px;
  background: var(--widget-primary-color, #667eea);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  align-self: flex-start;
}

.admin-test-button:hover:not(:disabled) {
  background: var(--widget-accent-color, #764ba2);
  transform: translateY(-1px);
}

.admin-test-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.admin-test-response {
  padding: 12px;
  background: #f8f9fa;
  border-radius: 6px;
  border-left: 3px solid var(--widget-primary-color, #667eea);
  font-size: 13px;
  line-height: 1.6;
}

.admin-test-response strong {
  display: block;
  margin-bottom: 8px;
  color: #333;
  font-weight: 600;
}

.admin-test-response div {
  color: #666;
}

.admin-panel-content::-webkit-scrollbar,
.admin-log-area::-webkit-scrollbar,
.admin-file-list::-webkit-scrollbar {
  width: 6px;
}

.admin-panel-content::-webkit-scrollbar-track,
.admin-log-area::-webkit-scrollbar-track,
.admin-file-list::-webkit-scrollbar-track {
  background: #f1f1f1;
}

.admin-panel-content::-webkit-scrollbar-thumb,
.admin-log-area::-webkit-scrollbar-thumb,
.admin-file-list::-webkit-scrollbar-thumb {
  background: #c1c1c1;
  border-radius: 3px;
}

.admin-panel-content::-webkit-scrollbar-thumb:hover,
.admin-log-area::-webkit-scrollbar-thumb:hover,
.admin-file-list::-webkit-scrollbar-thumb:hover {
  background: #a8a8a8;
}

/* Responsive */
@media (max-width: 480px) {
  .chat-window {
    width: calc(100vw - 20px);
    height: calc(100vh - 100px);
    bottom: 70px;
    right: 10px;
  }

  .chat-button {
    width: 56px;
    height: 56px;
    bottom: 15px;
    right: 15px;
  }
}
`;

/**
 * Inject CSS styles into the document head
 * This ensures styles are always available even if CSS file isn't loaded
 */
export function injectStyles() {
  // Check if styles already injected
  if (document.getElementById('visor-ai-widget-styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'visor-ai-widget-styles';
  style.textContent = widgetStyles;
  document.head.appendChild(style);
}
