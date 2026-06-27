const { Pool } = require('pg');

function poissonPMF(l,k){if(k<0||l<=0)return k===0?1:0;let lp=-l+k*Math.log(l);for(let i=1;i<=k;i++)lp-=Math.log(i);return Math.exp(lp);}
function dcTau(x,y,mA,mB){const r=-0.13;if(x===0&&y===0)return 1-mA*mB*r;if(x===0&&y===1)return 1+mA*r;if(x===1&&y===0)return 1+mB*r;if(x===1&&y===1)return 1-r;return 1;}
function dcMatrix(mA,mB){const m=[];for(let i=0;i<=7;i++){m[i]=[];for(let j=0;j<=7;j++)m[i][j]=dcTau(i,j,mA,mB)*poissonPMF(mA,i)*poissonPMF(mB,j);}let t=0;for(let i=0;i<=7;i++)for(let j=0;j<=7;j++)t+=m[i][j];for(let i=0;i<=7;i++)for(let j=0;j<=7;j++)m[i][j]/=t;return m;}
function sampleMat(mat){let r=Math.random(),c=0;for(let i=0;i<mat.length;i++)for(let j=0;j<mat[i].length;j++){c+=mat[i][j];if(r<c)return{ga:i,gb:j};}return{ga:1,gb:1};}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { muA, muB, n = 10000 } = req.body;
    const matrix = dcMatrix(muA, muB);
    let winsA=0, draws=0, winsB=0;
    const sf={};
    for (let i=0;i<n;i++) {
      const {ga,gb}=sampleMat(matrix);
      if(ga>gb)winsA++;else if(ga<gb)winsB++;else draws++;
      const k=`${ga}-${gb}`;sf[k]=(sf[k]||0)+1;
    }
    res.status(200).json({
      n,
      probabilities:{winA:+(winsA/n*100).toFixed(1),draw:+(draws/n*100).toFixed(1),winB:+(winsB/n*100).toFixed(1)},
      topScores:Object.entries(sf).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([score,count])=>({score,pct:+(count/n*100).toFixed(1)})),
      expectedGoals:+(muA+muB).toFixed(2),
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
};