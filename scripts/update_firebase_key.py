#!/usr/bin/env python3
"""
Updates designwear-backend/.env.local with the new Firebase service account key.
Also prints the exact value to paste into the Vercel FIREBASE_SERVICE_ACCOUNT_KEY env var.

Usage:
    python3 scripts/update_firebase_key.py path/to/service-account.json
"""

import json
import sys
import re
import os

def main():
    sa_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(__file__),
        '../../designwear-backend/designwear-731c9-firebase-adminsdk-fbsvc-b86263b0f2.json'
    )

    with open(sa_path) as f:
        sa = json.load(f)

    project_id = sa['project_id']
    print(f"\n✅ Loaded service account for project: {project_id}\n")

    # Produce a compact single-line JSON with \\n escapes for private_key
    # (dotenv-safe format: single-quoted value, \\n in the key)
    sa_compact = json.dumps(sa, separators=(',', ':'))
    # json.dumps already escapes the private_key newlines as \n — double-escape for .env.local
    sa_dotenv = sa_compact.replace('\\n', '\\\\n')
    env_value_dotenv = f"'{sa_dotenv}'"

    # For Vercel (paste raw single-line JSON with \\n — NOT double-quoted outer wrapper)
    # Vercel stores it as-is; our database.ts handles the \n normalization at runtime.
    env_value_vercel = sa_compact  # single line, \n in private_key (valid JSON)

    # --- Update .env.local ---
    env_path = os.path.join(os.path.dirname(__file__), '../.env.local')
    with open(env_path) as f:
        content = f.read()

    # Update FIREBASE_PROJECT_ID
    content = re.sub(
        r'^FIREBASE_PROJECT_ID=.*$',
        f'FIREBASE_PROJECT_ID="{project_id}"',
        content, flags=re.MULTILINE
    )

    # Update FIREBASE_SERVICE_ACCOUNT_KEY
    content = re.sub(
        r"^FIREBASE_SERVICE_ACCOUNT_KEY=.*$",
        f"FIREBASE_SERVICE_ACCOUNT_KEY={env_value_dotenv}",
        content, flags=re.MULTILINE
    )

    # Update FIREBASE_STORAGE_BUCKET if it still points to old project
    old_bucket = re.search(r'FIREBASE_STORAGE_BUCKET="([^"]+)"', content)
    if old_bucket and 'designwear-app-8984' in old_bucket.group(1):
        content = re.sub(
            r'^FIREBASE_STORAGE_BUCKET=.*$',
            f'FIREBASE_STORAGE_BUCKET="{project_id}.firebasestorage.app"',
            content, flags=re.MULTILINE
        )

    with open(env_path, 'w') as f:
        f.write(content)

    print(f"✅ Updated .env.local:")
    print(f"   FIREBASE_PROJECT_ID = {project_id}")
    print(f"   FIREBASE_SERVICE_ACCOUNT_KEY = (updated)")
    print(f"   FIREBASE_STORAGE_BUCKET = {project_id}.firebasestorage.app\n")

    print("=" * 60)
    print("📋 PASTE THIS INTO VERCEL → Environment Variables")
    print("   Variable name:  FIREBASE_SERVICE_ACCOUNT_KEY")
    print("   Variable value (copy everything between the lines):")
    print("-" * 60)
    print(env_value_vercel)
    print("-" * 60)
    print("\nAlso update in Vercel:")
    print(f"   FIREBASE_PROJECT_ID = {project_id}")
    print(f"   FIREBASE_STORAGE_BUCKET = {project_id}.firebasestorage.app")
    print("\nThen redeploy on Vercel (Deployments → Redeploy).\n")

if __name__ == '__main__':
    main()
