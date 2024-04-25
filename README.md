## Deploying Updates

1. Sync bfb-api to ec2/app
   rsync -avz --exclude 'node_modules' --exclude ktc_scraper.py --exclude updateProd.txt --exclude 'env' --exclude '.git' --exclude '.env' \-e "ssh -i ~/.ssh/BFB.pem" \. ec2-user@ec2-44-220-147-91.compute-1.amazonaws.com:~/app

2. Login to EC2
   ssh -i "~/.ssh/BFB.pem" ec2-user@ec2-44-220-147-91.compute-1.amazonaws.com

3. Restart EC2
   pm2 restart all

## Updating Dynasty Ranking

1. Run python script

- python ktc_scraper.py

2. Copy output to dynastyRankings in tasks.js
3. Redeploy ec2 (above)
4. Run updateDynastyRankings (go to api.badfranchisebuilders.com/updateDynasty)
