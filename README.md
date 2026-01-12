ApplySense

ApplySense is a Chrome extension that helps you avoid accidentally applying to the same or similar jobs multiple times on LinkedIn.

When browsing LinkedIn Jobs, ApplySense checks your past applications for the same company and shows a clear status so you can decide whether to apply again or move on.

The goal is simple: apply intentionally, not blindly.

Why ApplySense exists

Large companies often post many similar roles across teams, locations, and locations. During an active job search, it’s easy to lose track and apply repeatedly to the same or nearly identical roles.

ApplySense solves this by giving you context at the moment you view a job posting.

How ApplySense works

You browse job listings on LinkedIn Jobs.

When a job page loads, ApplySense reads the job title, company name, and job description shown on the page.

When you apply to a job, ApplySense stores minimal job metadata locally in your browser.

When you view another job at the same company, ApplySense compares it against your past applications and shows one of the following states:

New job: you have not applied to this company yet.

Similar role: you have applied to a similar role at the same company.

Exact duplicate: you have already applied to this job.

Even when a warning is shown, you remain fully in control and can still choose to apply.

Info panel

ApplySense includes a small info button next to the status indicator.

Clicking it shows:

Your recent applications at the same company

Role titles

Date and time of application

A short summary of each job description

This helps you quickly recall what you have already applied to without maintaining spreadsheets or notes.

Privacy and data handling

ApplySense is designed to be privacy-first.

All data is stored locally using Chrome storage

No data is sent to external servers

No analytics, tracking, or ads

No accounts or sign-ups required

No personal identifiers are collected

All stored data can be removed at any time by uninstalling the extension or clearing browser storage.

Privacy policy:
https://soumy0342.github.io/ApplySense/privacy-policy.html

Manual installation (offline / pre–Chrome Web Store)

If the extension is not yet available on the Chrome Web Store, you can install ApplySense manually using the source code. This method works fully offline.

Step 1: Get the source code

Option A: Download ZIP

Click the Code button on this repository

Select Download ZIP

Extract the ZIP file on your computer

Option B: Clone the repository

git clone https://github.com/Soumya0342/ApplySense.git

Step 2: Open Chrome extensions page

Open Google Chrome

Go to:

chrome://extensions


Enable Developer mode (top-right corner)

Step 3: Load the extension

Click Load unpacked

Select the folder that contains:

manifest.json

content.js

background.js

icon files

Important: select the ApplySense folder itself, not a parent folder.

Step 4: Verify installation

After loading:

ApplySense should appear in the extensions list

Ensure the extension is enabled

Step 5: Use ApplySense

Visit LinkedIn Jobs:

https://www.linkedin.com/jobs


Open any job listing

ApplySense will automatically show the job status

Click the info button to view recent applications for the same company

No configuration is required.

Updating the extension manually

If you update the source code later:

Replace the existing files with the new ones

Open chrome://extensions

Click Reload on ApplySense

Removing the extension

To completely remove ApplySense:

Open chrome://extensions

Click Remove on ApplySense

All locally stored data will be deleted automatically.

Supported site

LinkedIn Jobs (linkedin.com/jobs)

Status

ApplySense is currently under review for the Chrome Web Store.
Once approved, it will be available for one-click installation with automatic updates.
