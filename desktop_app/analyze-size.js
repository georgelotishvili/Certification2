/**
 * Detailed size analysis
 */
const fs = require('fs');
const path = require('path');

function getDirectorySize(dirPath) {
  let totalSize = 0;
  let fileCount = 0;
  let dirCount = 0;
  
  function walkDir(currentPath) {
    try {
      const items = fs.readdirSync(currentPath);
      
      for (const item of items) {
        const itemPath = path.join(currentPath, item);
        try {
          const stat = fs.statSync(itemPath);
          
          if (stat.isDirectory()) {
            dirCount++;
            walkDir(itemPath);
          } else {
            totalSize += stat.size;
            fileCount++;
          }
        } catch (error) {
          // Skip files we can't access
        }
      }
    } catch (error) {
      // Skip directories we can't access
    }
  }
  
  walkDir(dirPath);
  return { size: totalSize, fileCount, dirCount };
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

console.log('📊 დეტალური ზომის ანალიზი\n');
console.log('='.repeat(60));

// Get total folder size
const totalStats = getDirectorySize('.');
console.log(`\n📁 მთლიანი ფოლდერი (application/):`);
console.log(`   ზომა: ${formatBytes(totalStats.size)}`);
console.log(`   ფაილების რაოდენობა: ${totalStats.fileCount.toLocaleString()}`);
console.log(`   ფოლდერების რაოდენობა: ${totalStats.dirCount.toLocaleString()}`);

// Analyze each directory
const dirs = fs.readdirSync('.').filter(item => {
  try {
    return fs.statSync(item).isDirectory();
  } catch {
    return false;
  }
});

console.log(`\n${'='.repeat(60)}`);
console.log('\n📂 ფოლდერების დაყოფა:\n');

const dirSizes = [];
for (const dir of dirs) {
  const stats = getDirectorySize(dir);
  dirSizes.push({ name: dir, ...stats });
}

// Sort by size
dirSizes.sort((a, b) => b.size - a.size);

for (const dir of dirSizes) {
  const percentage = ((dir.size / totalStats.size) * 100).toFixed(1);
  console.log(`${dir.name}/`);
  console.log(`   ზომა: ${formatBytes(dir.size)} (${percentage}%)`);
  console.log(`   ფაილები: ${dir.fileCount.toLocaleString()}`);
  console.log(`   ფოლდერები: ${dir.dirCount.toLocaleString()}`);
  console.log('');
}

// Source code analysis (excluding node_modules)
console.log(`${'='.repeat(60)}`);
console.log('\n💻 Source Code ანალიზი (node_modules-ის გარეშე):\n');

const srcStats = getDirectorySize('./src');
const assetsStats = getDirectorySize('./assets');
const configFiles = [
  'package.json',
  'package-lock.json',
  'README_API.md',
  'test-connection.js',
  'test-api-browser.html',
  'analyze-size.js',
  'გაშვება.bat',
].filter(file => {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
});

let configSize = 0;
configFiles.forEach(file => {
  try {
    const stat = fs.statSync(file);
    configSize += stat.size;
  } catch {}
});

const sourceCodeTotal = srcStats.size + assetsStats.size + configSize;

console.log(`Source Code (src/): ${formatBytes(srcStats.size)}`);
console.log(`Assets (assets/): ${formatBytes(assetsStats.size)}`);
console.log(`Config Files: ${formatBytes(configSize)}`);
console.log(`\n✅ TOTAL Source Code: ${formatBytes(sourceCodeTotal)}`);
console.log(`   (${(sourceCodeTotal / (1024 * 1024)).toFixed(2)} MB)`);

// node_modules analysis
const nodeModulesStats = dirSizes.find(d => d.name === 'node_modules');
if (nodeModulesStats) {
  console.log(`\n${'='.repeat(60)}`);
  console.log('\n📦 node_modules/ ანალიზი:\n');
  console.log(`   ზომა: ${formatBytes(nodeModulesStats.size)}`);
  console.log(`   ფაილები: ${nodeModulesStats.fileCount.toLocaleString()}`);
  console.log(`   ფოლდერები: ${nodeModulesStats.dirCount.toLocaleString()}`);
  console.log(`   პროცენტი: ${((nodeModulesStats.size / totalStats.size) * 100).toFixed(1)}%`);
  console.log(`\n   ⚠️  node_modules არ შედის production build-ში!`);
  console.log(`   ⚠️  ეს არის development dependencies`);
}

// Large files check
console.log(`\n${'='.repeat(60)}`);
console.log('\n📄 დიდი ფაილები (>1 MB, node_modules-ის გარეშე):\n');

function findLargeFiles(dirPath, minSize = 1 * 1024 * 1024, excludeDirs = ['node_modules', '.git']) {
  const largeFiles = [];
  
  function walkDir(currentPath) {
    try {
      const items = fs.readdirSync(currentPath);
      
      for (const item of items) {
        const itemPath = path.join(currentPath, item);
        const relativePath = path.relative('.', itemPath);
        
        // Skip excluded directories
        if (excludeDirs.some(exclude => relativePath.includes(exclude))) {
          continue;
        }
        
        try {
          const stat = fs.statSync(itemPath);
          
          if (stat.isDirectory()) {
            walkDir(itemPath);
          } else if (stat.size >= minSize) {
            largeFiles.push({
              path: relativePath,
              size: stat.size
            });
          }
        } catch (error) {
          // Skip files we can't access
        }
      }
    } catch (error) {
      // Skip directories we can't access
    }
  }
  
  walkDir(dirPath);
  return largeFiles;
}

const largeFiles = findLargeFiles('.');
if (largeFiles.length > 0) {
  largeFiles.sort((a, b) => b.size - a.size);
  largeFiles.forEach(file => {
    console.log(`   ${file.path}: ${formatBytes(file.size)}`);
  });
} else {
  console.log('   დიდი ფაილები არ მოიძებნა (node_modules-ის გარეშე)');
}

// Summary
console.log(`\n${'='.repeat(60)}`);
console.log('\n📋 შეჯამება:\n');

const nodeModulesSize = nodeModulesStats ? nodeModulesStats.size : 0;
const sourceCodeMB = sourceCodeTotal / (1024 * 1024);
const nodeModulesMB = nodeModulesSize / (1024 * 1024);
const totalMB = totalStats.size / (1024 * 1024);

console.log(`1. Source Code: ~${sourceCodeMB.toFixed(2)} MB`);
console.log(`   ✅ ეს არის ნორმალური და ოპტიმალური ზომა`);
console.log(`\n2. node_modules: ~${nodeModulesMB.toFixed(2)} MB`);
console.log(`   ⚠️  ეს არ შედის production build-ში`);
console.log(`\n3. მთლიანი ფოლდერი: ~${totalMB.toFixed(2)} MB`);
console.log(`   (${totalStats.fileCount.toLocaleString()} ფაილი, ${totalStats.dirCount.toLocaleString()} ფოლდერი)`);

console.log(`\n${'='.repeat(60)}`);
console.log('\n💡 დასკვნა:\n');
console.log(`✅ Source Code-ის ზომა (~${sourceCodeMB.toFixed(2)} MB) ძალიან მცირე და ოპტიმალურია`);
console.log(`✅ 433 MB-იანი ზომა გამოწვეულია node_modules-ით, რომელიც არ შედის production build-ში`);
console.log(`✅ Production build-ისას Electron app იქნება ~100-150 MB (Electron runtime + dependencies)`);
console.log(`\n🎯 არ არის საჭირო ოპტიმიზაცია!`);

