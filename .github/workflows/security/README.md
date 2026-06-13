# Security Workflows

This folder contains GitHub Actions workflows for automated security assessments that are separate from the main CI/CD pipeline.

## Daily Security Assessment (`daily-assessment.yml`)

### Purpose
- Runs automated vulnerability assessment daily at 9:00 AM IST
- Generates enhanced PDF security reports and emails them
- Does NOT interfere with deployments or other workflows

### Key Features
- **Scheduled Execution**: Runs daily via cron schedule
- **Branch Isolation**: Only runs on `main` branch
- **No Deployment Impact**: Completely separate from CI/CD
- **Artifact Storage**: Saves reports for 30 days
- **Email Notifications**: Sends PDF reports to configured email

### Required GitHub Secrets
Add these secrets in your repository settings:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=contactus@ropods.com
SMTP_PASS=your-app-password
FROM_NAME=Ropods Security
FROM_EMAIL=contactus@ropods.com
TEAM_EMAIL_2=kasinath@ropods.com
```

### Manual Trigger
You can manually run the assessment using GitHub Actions "Run workflow" button.

### Workflow Isolation
- Uses separate Node.js environment
- Installs only required dependencies
- No impact on main branch or deployments
- Runs independently of code changes

### Reports
- PDF reports emailed automatically
- JSON reports stored as artifacts
- 30-day retention for historical analysis

## Setup Instructions

1. **Add Secrets**: Configure required environment variables in GitHub repository secrets
2. **Test**: Use "Run workflow" to test manually before first scheduled run
3. **Monitor**: Check Actions tab for execution status
4. **Adjust Time**: Modify cron schedule if different timezone needed

## Timezone Note
Current schedule is 9:00 AM IST (3:30 AM UTC). Adjust the cron expression for other timezones:
- UTC: Use `0 9 * * *` for 9:00 AM UTC
- PST (UTC-8): Use `0 17 * * *` for 9:00 AM PST
- EST (UTC-5): Use `0 14 * * *` for 9:00 AM EST