// helper for website form API actions
async function loadWebsiteFormPage() {
  const page = document.getElementById('page-website');
  if (!page) return;
  page.innerHTML = `
    <section class="section website-page">
      <div class="website-card">
        <div class="website-top">
          <div class="website-hero">
            <div class="sec-label">Build a New Website</div>
            <h2>Request a Fresh <span style="color:var(--rust)">Website</span></h2>
            <p>Fill out this form to refresh the site styling, add new features, and customize your restaurant's online presence.</p>
            <div class="website-form-actions">
              <button class="btn-primary" onclick="showPage('home')">Back to Home</button>
              <button class="btn-secondary" onclick="showPage('admin')">Back to Admin</button>
            </div>
          </div>
          <div class="website-form">
            <div class="form-group"><label for="site-request-name">Your Name</label><input id="site-request-name" type="text" placeholder="Name"></div>
            <div class="form-group"><label for="site-request-email">Email</label><input id="site-request-email" type="email" placeholder="email@example.com"></div>
            <div class="form-group"><label for="site-request-phone">Phone</label><input id="site-request-phone" type="tel" placeholder="806-000-0000"></div>
            <div class="form-group"><label for="site-request-type">Request Type</label><select id="site-request-type"><option value="refresh">Refresh Existing Website</option><option value="new">New Website Brand</option><option value="landing_page">Landing Page</option><option value="menu_update">Menu Update</option></select></div>
            <div class="form-group"><label for="site-request-details">Project Details</label><textarea id="site-request-details" placeholder="Describe what you want: colors, sections, features, or new pages."></textarea></div>
            <div class="form-group"><label for="site-request-deadline">Target Completion Date</label><input id="site-request-deadline" type="date"></div>
            <button class="btn-primary" onclick="submitWebsiteRequest()">Submit Request</button>
            <p class="help-text">Requests will be saved to the backend and show in the admin panel for review.</p>
          </div>
        </div>
      </div>
    </section>
  `;
}

async function submitWebsiteRequest() {
  const name = document.getElementById('site-request-name').value;
  const email = document.getElementById('site-request-email').value;
  const phone = document.getElementById('site-request-phone').value;
  const type = document.getElementById('site-request-type').value;
  const details = document.getElementById('site-request-details').value;
  const deadline = document.getElementById('site-request-deadline').value;
  if (!name || !email || !details) {
    toast('Please fill in your name, email, and project details.', 'error');
    return;
  }
  try {
    await api('/website-requests', 'POST', { name, email, phone, type, details, deadline });
    toast('Website request submitted! The team will review it soon.', 'success');
    ['site-request-name','site-request-email','site-request-phone','site-request-details','site-request-deadline'].forEach(id => document.getElementById(id).value='');
  } catch (e) {
    toast(e.message, 'error');
  }
}
