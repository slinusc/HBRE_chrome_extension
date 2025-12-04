document.addEventListener('DOMContentLoaded', function () {
    // UI Elements
    const loginContainer = document.getElementById('login-container');
    const mainContainer = document.getElementById('main-container');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const backendUrlInput = document.getElementById('backendUrl');
    const loginBtn = document.getElementById('loginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const userGreeting = document.getElementById('user-greeting');
    const projectSelect = document.getElementById('projectSelect');
    const refreshProjectsBtn = document.getElementById('refreshProjectsBtn');
    const pushBtn = document.getElementById('pushBtn');
    const statusDiv = document.getElementById('status');

    // State
    let currentUser = null;
    let authToken = null;
    let backendUrl = 'https://your-app-url.com'; // Default - users should update this

    // Load settings and state
    chrome.storage.local.get(['lastBackendUrl', 'user', 'authToken', 'lastProjectId'], function (result) {
        if (result.lastBackendUrl) {
            backendUrl = result.lastBackendUrl;
            backendUrlInput.value = backendUrl;
        }
        if (result.user && result.authToken) {
            currentUser = result.user;
            authToken = result.authToken;
            showMainUI();
            // Restore last selected project if available
            if (result.lastProjectId) {
                projectSelect.value = result.lastProjectId;
            }
        } else {
            showLoginUI();
        }
    });

    // --- Status Helper ---
    function setStatus(message, type) {
        if (!message) {
            statusDiv.textContent = '';
            statusDiv.className = '';
            return;
        }
        statusDiv.textContent = message;
        statusDiv.className = `show ${type}`;
    }

    // --- UI Switching ---
    function showLoginUI() {
        loginContainer.style.display = 'block';
        mainContainer.style.display = 'none';
        setStatus('', '');
    }

    function showMainUI() {
        loginContainer.style.display = 'none';
        mainContainer.style.display = 'block';
        userGreeting.textContent = currentUser.username || currentUser.email || 'User';
        fetchProjects();
    }

    // --- Actions ---

    loginBtn.addEventListener('click', async () => {
        const username = emailInput.value.trim();
        const password = passwordInput.value.trim();
        backendUrl = backendUrlInput.value.trim().replace(/\/$/, '');

        if (!username || !password || !backendUrl) {
            statusDiv.textContent = 'Please fill in all fields.';
            statusDiv.className = 'error';
            return;
        }

        statusDiv.textContent = 'Logging in...';
        statusDiv.className = '';

        try {
            const response = await fetch(`${backendUrl}/api/extension/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    currentUser = data.user;
                    authToken = data.token;

                    // Save state
                    chrome.storage.local.set({
                        user: currentUser,
                        authToken: authToken,
                        lastBackendUrl: backendUrl
                    });

                    statusDiv.textContent = 'Login successful!';
                    statusDiv.className = 'success';
                    showMainUI();
                } else {
                    statusDiv.textContent = 'Login failed: ' + (data.error || 'Unknown error');
                    statusDiv.className = 'error';
                }
            } else {
                const errData = await response.json();
                statusDiv.textContent = 'Login failed: ' + (errData.error || 'Unknown error');
                statusDiv.className = 'error';
            }
        } catch (err) {
            statusDiv.textContent = 'Error: ' + err.message;
            statusDiv.className = 'error';
        }
    });

    logoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.storage.local.remove(['user', 'authToken']);
        currentUser = null;
        authToken = null;
        showLoginUI();
    });

    refreshProjectsBtn.addEventListener('click', fetchProjects);

    async function fetchProjects() {
        projectSelect.innerHTML = '<option>Loading...</option>';
        try {
            const response = await fetch(`${backendUrl}/api/extension/projects?token=${authToken}`, {
                headers: {
                    'Authorization': authToken
                }
            });
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    const projects = data.projects;
                    projectSelect.innerHTML = '<option value="">Select a project...</option>';

                    projects.forEach(p => {
                        const option = document.createElement('option');
                        option.value = p.project_id;
                        option.textContent = p.project_name;
                        projectSelect.appendChild(option);
                    });

                    // Restore last selected if available
                    chrome.storage.local.get(['lastProjectId'], (result) => {
                        if (result.lastProjectId) {
                            projectSelect.value = result.lastProjectId;
                        }
                    });
                } else {
                    projectSelect.innerHTML = '<option>Error loading projects</option>';
                }
            } else {
                projectSelect.innerHTML = '<option>Error loading projects</option>';
            }
        } catch (err) {
            projectSelect.innerHTML = '<option>Connection error</option>';
        }
    }

    // Save selected project
    projectSelect.addEventListener('change', () => {
        chrome.storage.local.set({ lastProjectId: projectSelect.value });
    });


    // --- Scraping & Pushing ---

    const handleAction = async () => {
        const projectId = projectSelect.value;

        // Validate project selection
        if (!projectId) {
            setStatus('Please select a project first', 'error');
            return;
        }

        setStatus('Loading listing data...', 'info');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab.url.includes('immoscout24.ch') && !tab.url.includes('homegate.ch')) {
                setStatus('Please open a property listing on ImmoScout24 or Homegate', 'error');
                return;
            }

            // Helper to send message
            const sendMessage = (tabId) => {
                return new Promise((resolve, reject) => {
                    chrome.tabs.sendMessage(tabId, { action: 'scrape' }, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(chrome.runtime.lastError);
                        } else {
                            resolve(response);
                        }
                    });
                });
            };

            let response;
            try {
                response = await sendMessage(tab.id);
            } catch (e) {
                // If connection failed, try injecting script
                if (e.message.includes('Could not establish connection') || e.message.includes('Receiving end does not exist')) {
                    console.log('Injecting script manually...');
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        files: ['content.js']
                    });
                    // Retry
                    response = await sendMessage(tab.id);
                } else {
                    throw e;
                }
            }

            if (response && response.data) {
                const listingData = response.data;
                listingData.project_id = projectId;

                setStatus('Adding listing to project...', 'info');
                const endpoint = `${backendUrl}/api/extension/add-listing`;

                try {
                    const res = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': authToken
                        },
                        body: JSON.stringify(listingData)
                    });

                    if (res.ok) {
                        const result = await res.json();
                        if (result.success) {
                            setStatus('✓ Listing successfully added to project!', 'success');
                        } else {
                            setStatus('Error: ' + (result.error || 'Unknown error'), 'error');
                        }
                    } else {
                        const errData = await res.json();
                        setStatus(`Error: ${errData.error || 'Unknown error'}`, 'error');
                    }
                } catch (fetchErr) {
                    setStatus('Error: Could not connect to H&B Tool. Check your URL.', 'error');
                }

            } else {
                setStatus('Error: Could not extract listing data', 'error');
            }
        } catch (err) {
            setStatus('Error: ' + err.message, 'error');
        }
    };

    pushBtn.addEventListener('click', handleAction);
});
