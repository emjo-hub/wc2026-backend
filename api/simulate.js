const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

function poissonPMF(l,k){if(k<0||l<=0)return k===0?1:0;let lp=-l+k*Math.log(l);for(let i=1;i<=k;i++)lp-=Math.log(i);return Math.exp(lp);}
function dcTau(x,y,mA,mB){const r=-0.08;if(x===0&&y===0)return 1-mA*mB*r;if(x===0&&y===1)return 1+mA*r;if(x===1&&y===0)return 1+mB*r;if(x===1&&y===1)return 1-r;return 1;}
function dcMatrix(mA,mB){const m=[];for(let i=0;i<=7;i++){m[i]=[];for(let j=0;j<=7;j++)m[i][j]=dcTau(i,j,mA,mB)*poissonPMF(mA,i)*poissonPMF(mB,j);}let t=0;for(let i=0;i<=7;i++)for(let j=0;j<=7;j++)t+=m[i][j];for(let i=0;i<=7;i++)for(let j=0;j<=7;j++)m[i][j]/=t;return m;}
function sampleMat(mat){let r=Math.random(),c=0;for(let i=0;i<mat.length;i++)for(let j=0;j<mat[i].length;j++){c+=mat[i][j];if(r<c)return{ga:i,gb:j};}return{ga:1,gb:1};}
function simPenalties(ta, tb) {
  // Probabilidad base de ganar penales: 50/50 ajustada por Elo
  const eloAdv = Math.max(-0.1, Math.min(0.1, (ta.elo - tb.elo) / 4000));
  const probA = 0.50 + eloAdv;
  return Math.random() < probA ? 'a' : 'b';
}

function simExtraTime(muA, muB) {
  // En prórroga los equipos están cansados — reducimos lambdas 40%
  const etMuA = muA * 0.6;
  const etMuB = muB * 0.6;
  const mat = dcMatrix(etMuA, etMuB);
  const { ga, gb } = sampleMat(mat);
  return { ga, gb };
}
function eloProbs(eA,eB){const pW=1/(1+Math.pow(10,(eB-eA+50)/400));const pD=Math.max(0.10,Math.min(0.30,0.22+0.10*(1-Math.abs(pW-0.5)*2.2)));return{win:+pW.toFixed(4),draw:+pD.toFixed(4),lose:+Math.max(0,1-pW-pD).toFixed(4)};}
function pSample(l){if(l<=0)return 0;let L=Math.exp(-l),k=0,p=1;do{k++;p*=Math.random();}while(p>L&&k<25);return k-1;}
function simCorners(ta,tb){const pfA=Math.max(0.85,1-ta.ppda/30),pfB=Math.max(0.85,1-tb.ppda/30);const c1a=pSample(Math.max(0.2,(ta.possession_avg/100)*1.8*pfA)),c2a=pSample(Math.max(0.2,(ta.possession_avg/100)*1.6*pfA)),c1b=pSample(Math.max(0.2,(tb.possession_avg/100)*1.6*pfB)),c2b=pSample(Math.max(0.2,(tb.possession_avg/100)*1.8*pfB));return{c1a,c2a,cta:c1a+c2a,c1b,c2b,ctb:c1b+c2b,total:c1a+c2a+c1b+c2b};}
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { teamA, teamB, context = {} } = req.body;
    if (!teamA || !teamB) return res.status(400).json({ error: 'Faltan equipos' });
    if (teamA === teamB) return res.status(400).json({ error: 'Los equipos deben ser diferentes' });

const { rows } = await pool.query(`
    SELECT 
    t.name, t.elo, t.fifa_rank, t.flag, t.confederation,
    t.xg_avg, t.xga_avg, t.ppda, t.possession_avg,
    t.shots_avg, t.set_piece_xg, t.star_player, t.wc_appearances,
    t.recent_form,
    COALESCE(ts.xg_last_5, t.xg_avg) AS xg_recent,
    COALESCE(ts.goals_scored, 0) AS goals_scored,
    COALESCE(ts.points, 0) AS points,
    COALESCE(ts.matchday, 0) AS matchday,
    ts.xg_match1, ts.xg_match2, ts.xg_match3, ts.xg_match4
  FROM teams t 
  LEFT JOIN team_tournament_stats ts ON ts.team_name = t.name
  WHERE LOWER(t.name) IN (LOWER($1), LOWER($2))
`, [teamA, teamB]);

    const ta = rows.find(r => r.name.toLowerCase() === teamA.toLowerCase());
    const tb = rows.find(r => r.name.toLowerCase() === teamB.toLowerCase());
    if (!ta) return res.status(404).json({ error: `Equipo no encontrado: ${teamA}` });
    if (!tb) return res.status(404).json({ error: `Equipo no encontrado: ${teamB}` });

    const ctx = (context.weather||1)*(context.phase||1)*(context.rest||1);
    // Elo dinámico basado en rendimiento del torneo
    const K = 60;
    const eloBase_a = ta.elo;
    const eloBase_b = tb.elo;
    const matchesA = ta.matchday || 0;
    const matchesB = tb.matchday || 0;
    const winRateA = matchesA > 0 ? ta.points / (matchesA * 3) : 0.5;
    const winRateB = matchesB > 0 ? tb.points / (matchesB * 3) : 0.5;
    const expectedA = 1 / (1 + Math.pow(10, (eloBase_b - eloBase_a) / 400));
    const eloAdjA = Math.round(K * matchesA * (winRateA - expectedA));
    const eloAdjB = Math.round(K * matchesB * (winRateB - expectedA));
    const elo_a = eloBase_a + eloAdjA;
    const elo_b = eloBase_b + eloAdjB;
    const eloP = eloProbs(elo_a, elo_b);

    // Lambdas con Elo dinámico
    console.log('DEBUG:', ta.name, 'matchday:', ta.matchday, 'xg_match1:', ta.xg_match1, 'xg_match2:', ta.xg_match2, 'xg_match3:', ta.xg_match3);
    const ef = Math.max(-0.8, Math.min(0.8, (elo_a - elo_b) / 600));
    // Forma reciente ponderada
function weightedXG(t) {
  const m = t.matchday || 0;
  const m1 = parseFloat(t.xg_match1 || 0);
  const m2 = parseFloat(t.xg_match2 || 0);
  const m3 = parseFloat(t.xg_match3 || 0);
  const m4 = parseFloat(t.xg_match4 || 0);
  if (m >= 4) return (m1*0.10 + m2*0.20 + m3*0.30 + m4*0.40);
  if (m === 3) return (m1*0.20 + m2*0.35 + m3*0.45);
  if (m === 2) return (m1*0.40 + m2*0.60);
  return parseFloat(t.xg_recent || t.xg_avg || 1.2);
}
const xg_a = Math.max(0.3, weightedXG(ta));
const xg_b = Math.max(0.3, weightedXG(tb));
    const xgDef_a = parseFloat(tb.xga_avg || 1.2);
    const xgDef_b = parseFloat(ta.xga_avg || 1.2);
    const pts_a = parseFloat(ta.points || 0);
    const pts_b = parseFloat(tb.points || 0);

    let raw_a = Math.max(0.3, (xg_a * 0.45) + (xgDef_a * 0.20) + (ef * 0.20) + (pts_a * 0.04));
    let raw_b = Math.max(0.3, (xg_b * 0.45) + (xgDef_b * 0.20) - (ef * 0.20) + (pts_b * 0.04));

    const total_raw = raw_a + raw_b;
    const TARGET = 2.60;
    const muA = Math.max(0.4, parseFloat((raw_a / total_raw * TARGET * ctx).toFixed(3)));
    const muB = Math.max(0.35, parseFloat((raw_b / total_raw * TARGET * ctx).toFixed(3)));

    const matrix = dcMatrix(muA, muB);
    const {ga, gb} = sampleMat(matrix);
    const corners = simCorners(ta, tb);
    const rand=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;
    const ev=[];
    const pA=[ta.star_player,'Delantero','Mediocampista','Extremo','Defensa SP'];
    const pB=[tb.star_player,'Delantero','Mediocampista','Extremo','Defensa SP'];
    for(let i=0;i<ga;i++){const sp=Math.random()<(ta.set_piece_xg/((ta.xg_avg*1.4)||1))*.5,ph=Math.random(),m=ph<.22?rand(3,22):ph<.52?rand(23,55):ph<.78?rand(56,78):rand(79,95);ev.push({min:m,team:'a',type:sp?'setpiece':'goal',player:pA[i%pA.length]});}
    for(let i=0;i<gb;i++){const sp=Math.random()<(tb.set_piece_xg/((tb.xg_avg*1.4)||1))*.5,ph=Math.random(),m=ph<.18?rand(8,25):ph<.48?rand(26,58):ph<.76?rand(59,82):rand(83,96);ev.push({min:m,team:'b',type:sp?'setpiece':'goal',player:pB[i%pB.length]});}
    ev.sort((a,b)=>a.min-b.min);
    const eloRatio=ta.elo/(ta.elo+tb.elo),possA=Math.round(Math.max(28,Math.min(72,ta.possession_avg*(0.92+eloRatio*0.16))));

    // Lógica eliminatoria
    let finalGa = ga, finalGb = gb;
    let extraTime = false, penalties = false, penaltyWinner = null;
    const isKnockout = (context.phase || 1) >= 1.05;

    if (isKnockout && ga === gb) {
      extraTime = true;
      const etMuA = muA * 0.6;
      const etMuB = muB * 0.6;
      const etMat = dcMatrix(etMuA, etMuB);
      const et = sampleMat(etMat);
      finalGa += et.ga;
      finalGb += et.gb;

      if (finalGa === finalGb) {
        penalties = true;
        const eloAdv = Math.max(-0.1, Math.min(0.1, (ta.elo - tb.elo) / 4000));
        penaltyWinner = Math.random() < (0.50 + eloAdv) ? 'a' : 'b';
      }
    }

    res.status(200).json({
      result:{
        ga: finalGa,
        gb: finalGb,
        extraTime,
        penalties,
        penaltyWinner,
        winner: finalGa > finalGb ? 'a' : finalGb > finalGa ? 'b' : penaltyWinner
      },
      teams:{a:{name:teamA,flag:ta.flag,elo:ta.elo,rank:ta.fifa_rank},b:{name:teamB,flag:tb.flag,elo:tb.elo,rank:tb.fifa_rank}},
      model:{muA,muB,expectedGoals:+(muA+muB).toFixed(2),eloProbs:eloP},
      matrix:matrix.slice(0,5).map(r=>r.slice(0,5)),
      corners, events:ev,
      stats:{possession:{a:possA,b:100-possA},shots:{a:Math.max(3,Math.round(ta.shots_avg*(.85+Math.random()*.3)+ga*1.5)),b:Math.max(3,Math.round(tb.shots_avg*(.85+Math.random()*.3)+gb*1.5))},xg:{a:+muA.toFixed(2),b:+muB.toFixed(2)},ppda:{a:+(ta.ppda*(.92+Math.random()*.16)).toFixed(1),b:+(tb.ppda*(.92+Math.random()*.16)).toFixed(1)},setpieceXg:{a:+(ta.set_piece_xg*(.85+Math.random()*.3)).toFixed(2),b:+(tb.set_piece_xg*(.85+Math.random()*.3)).toFixed(2)}},
    });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno', detail: err.message });
  }
};