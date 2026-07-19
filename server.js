const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const app = express();
const PORT = 3000;

// 缓存数据
let cache = {
  data: [],
  lastUpdated: null,
  isUpdating: false
};

// 请求配置
const axiosConfig = {
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
};

// 从页面中提取所有链接（包括 <a> 标签和纯文本中的URL）
function extractAllLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = new Set();
  
  $('a').each((i, el) => {
    let href = $(el).attr('href');
    if (!href) return;
    href = href.trim();
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      links.add(absoluteUrl);
    } catch (e) {}
  });
  
  const urlPattern = /https?:\/\/[^\s"'<>()]+/gi;
  const matches = html.match(urlPattern);
  if (matches) {
    matches.forEach(url => {
      url = url.replace(/['",;:)\]}>]+$/, '').trim();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        try {
          const absoluteUrl = new URL(url, baseUrl).href;
          links.add(absoluteUrl);
        } catch (e) {}
      }
    });
  }
  
  return Array.from(links);
}

// 从URL中提取日期
function extractDateFromUrl(url) {
  const dateMatch = url.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (dateMatch) {
    return new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
  }
  // 尝试 YYYYMMDD 格式
  const compactMatch = url.match(/(\d{4})(\d{2})(\d{2})/);
  if (compactMatch) {
    const y = parseInt(compactMatch[1]);
    const m = parseInt(compactMatch[2]) - 1;
    const d = parseInt(compactMatch[3]);
    if (y > 2020 && y < 2030 && m >= 0 && m <= 11 && d >= 1 && d <= 31) {
      return new Date(y, m, d);
    }
  }
  return null;
}

// 从文章中提取 .yaml 订阅链接
async function scrapeArticleForYamlLinks(articleUrl, sourceName) {
  try {
    const response = await axios.get(articleUrl, axiosConfig);
    const allLinks = extractAllLinks(response.data, articleUrl);
    
    const yamlLinks = allLinks.filter(link => link.match(/\.(yaml|yml)(\?|$)/i));
    
    if (yamlLinks.length > 0) {
      let articleDate = extractDateFromUrl(articleUrl);
      
      // 如果文章URL没有日期，尝试从 .yaml URL 中提取
      if (!articleDate) {
        for (const yamlUrl of yamlLinks) {
          const dateFromYaml = extractDateFromUrl(yamlUrl);
          if (dateFromYaml) {
            articleDate = dateFromYaml;
            break;
          }
        }
      }
      
      return {
        source: sourceName,
        articleUrl: articleUrl,
        date: articleDate ? articleDate.toISOString().split('T')[0] : null,
        dateObj: articleDate || new Date(0),
        links: yamlLinks
      };
    }
    return null;
  } catch (error) {
    return null;
  }
}

// 通用抓取器：从主页找文章链接，然后抓取每篇文章的 .yaml
async function scrapeGeneric(name, homepageUrl, articleFilter) {
  console.log(`[${name}] 开始抓取...`);
  try {
    const response = await axios.get(homepageUrl, axiosConfig);
    const allLinks = extractAllLinks(response.data, homepageUrl);
    
    // 使用自定义过滤器找文章链接
    const articleLinks = allLinks.filter(link => articleFilter(link));
    
    const uniqueArticles = [...new Set(articleLinks)];
    console.log(`[${name}] 发现 ${uniqueArticles.length} 篇文章`);
    
    // 只取最新的10篇
    const recentArticles = uniqueArticles.slice(0, 10);
    
    const results = [];
    for (const articleUrl of recentArticles) {
      const result = await scrapeArticleForYamlLinks(articleUrl, name);
      if (result && result.links.length > 0) {
        results.push(result);
        console.log(`  ${articleUrl} -> ${result.links.length} 个 .yaml 链接`);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    console.log(`[${name}] 完成，共获取 ${results.length} 篇文章的 .yaml 链接`);
    return results;
  } catch (error) {
    console.error(`[${name}] 抓取失败: ${error.message}`);
    return [];
  }
}

// 所有源站配置
const sources = [
  {
    name: 'ClashNodes',
    homepage: 'https://clashnodes.com/free-node/',
    articleFilter: (link) => {
      if (link.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|webp)$/i)) return false;
      if (link.includes('/tags/') || link.includes('/go/') || link.includes('/node-real-time-update/')) return false;
      return link.match(/\/(\d{4})-(\d{1,2})-(\d{1,2})/) && link.includes('/free-node/');
    }
  },
  {
    name: 'FreeClashNode',
    homepage: 'https://www.freeclashnode.com/free-node/',
    articleFilter: (link) => {
      if (link.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|webp)$/i)) return false;
      if (link.includes('/tags/') || link.includes('/go/') || link.includes('/node-real-time-update/')) return false;
      return link.match(/\/(\d{4})-(\d{1,2})-(\d{1,2})/) && link.includes('/free-node/');
    }
  },
  {
    name: 'NodeFree',
    homepage: 'https://nodefree.me/f/freenode',
    articleFilter: (link) => {
      return link.match(/https:\/\/nodefree\.me\/p\/\d+\.html/i);
    }
  },
  {
    name: 'ClashGithub',
    homepage: 'https://clashgithub.com/',
    articleFilter: (link) => {
      if (link.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|webp)$/i)) return false;
      if (link.includes('/category/') || link.includes('/links') || link.includes('/cdn/')) return false;
      return link.match(/clashnode-\d{8}\.html/);
    }
  },
  {
    name: 'OneClash',
    homepage: 'https://oneclash.cc/',
    articleFilter: (link) => {
      if (link.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|webp)$/i)) return false;
      if (link.includes('/t/') || link.includes('/go/') || link.includes('/page/') || link.includes('/wp-')) return false;
      return link.match(/\/a\/\d+\.html/);
    }
  },
  {
    name: 'BingoClash',
    homepage: 'https://bingoclash.github.io/free-nodes/',
    articleFilter: (link) => {
      if (link.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|webp)$/i)) return false;
      if (link.includes('/tags/') || link.includes('/go/') || link.includes('/cdn/') || link.includes('/assets/')) return false;
      return link.match(/\/(\d{4})-(\d{1,2})-(\d{1,2})/) && link.includes('/free-nodes/');
    }
  },
  {
    name: 'MiBei77',
    homepage: 'https://www.mibei77.com/',
    articleFilter: (link) => {
      if (link.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|webp)$/i)) return false;
      if (link.includes('/wp-') || link.includes('/author/') || link.includes('/page/') || link.includes('/category/') || link.includes('/user-') || link.includes('?')) return false;
      return link.match(/https:\/\/www\.mibei77\.com\/\d+\.html/);
    }
  },
  {
    name: 'V2rayShare',
    homepage: 'https://v2rayshare.net/',
    articleFilter: (link) => {
      if (link.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|webp)$/i)) return false;
      if (link.includes('/t/') || link.includes('/go/') || link.includes('/page/') || link.includes('/wp-')) return false;
      return link.match(/\/p\/\d+\.html/);
    }
  },
  {
    name: 'OpenClash',
    homepage: 'https://openclash.cc/free-node/',
    articleFilter: (link) => {
      if (link.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|webp)$/i)) return false;
      if (link.includes('/tags/') || link.includes('/go/') || link.includes('/node-real-time-update/') || link.includes('/news/')) return false;
      return link.match(/\/(\d{4})-(\d{1,2})-(\d{1,2})/) && link.includes('/free-node/');
    }
  }
];

async function updateAllData() {
  if (cache.isUpdating) {
    console.log('正在更新中，跳过本次更新');
    return;
  }
  
  cache.isUpdating = true;
  console.log('========== 开始更新所有数据 ==========');
  
  try {
    const promises = sources.map(s => scrapeGeneric(s.name, s.homepage, s.articleFilter));
    const results = await Promise.allSettled(promises);
    
    // 合并所有结果
    let allEntries = [];
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        allEntries = allEntries.concat(result.value);
      }
    });
    
    // 按日期排序（最新的在前）
    allEntries.sort((a, b) => b.dateObj - a.dateObj);
    
    // 展平为统一的链接列表
    const flatLinks = [];
    for (const entry of allEntries) {
      for (const link of entry.links) {
        flatLinks.push({
          url: link,
          source: entry.source,
          articleUrl: entry.articleUrl,
          date: entry.date
        });
      }
    }
    
    cache.data = flatLinks;
    cache.lastUpdated = new Date().toISOString();
    console.log(`========== 更新完成，共获取 ${flatLinks.length} 个 .yaml 订阅链接 ==========`);
  } catch (error) {
    console.error('更新失败:', error.message);
  } finally {
    cache.isUpdating = false;
  }
}

// 静态文件服务
app.use(express.static('public'));

// API: 获取所有订阅链接
app.get('/api/links', (req, res) => {
  res.json({
    success: true,
    data: cache.data,
    lastUpdated: cache.lastUpdated,
    isUpdating: cache.isUpdating
  });
});

// API: 手动触发更新
app.post('/api/refresh', async (req, res) => {
  if (cache.isUpdating) {
    return res.json({
      success: false,
      message: '正在更新中，请稍后再试',
      isUpdating: true
    });
  }
  
  updateAllData();
  
  res.json({
    success: true,
    message: '开始更新',
    isUpdating: true
  });
});

// API: 获取更新状态
app.get('/api/status', (req, res) => {
  res.json({
    isUpdating: cache.isUpdating,
    lastUpdated: cache.lastUpdated,
    totalLinks: cache.data.length
  });
});

// 启动时立即更新
updateAllData();

// 每30分钟自动更新
cron.schedule('*/30 * * * *', () => {
  console.log('定时更新触发');
  updateAllData();
});

app.listen(PORT, () => {
  console.log(`服务器已启动: http://localhost:${PORT}`);
  console.log(`自动更新间隔: 30分钟`);
});
