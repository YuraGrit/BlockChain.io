const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const dotenv = require('dotenv');

// Завантаження змінних оточення
dotenv.config();

const app = express();
const port = process.env.BLOCKCHAIN_PORT;
const authServerUrl = process.env.AUTH_SERVER_URL || `https://registration-io.onrender.com`;

// Налаштування CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(bodyParser.json());


const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let blocksCollection;
let usersCollection; // Колекція користувачів для прямого доступу до інформації про ролі

// Підключення до бази даних
async function connectDB() {
  try {
    await client.connect();
    const db = client.db("BlockChain");
    blocksCollection = db.collection("blocks");
    
    // Підключення до колекції користувачів для перевірки ролей
    const authDb = client.db("Blockvote");
    usersCollection = authDb.collection("users");
    
    console.log("✅ Підключено до MongoDB");
  } catch (err) {
    console.log("❌ Помилка підключення до бази даних:", err);
  }
}

// Функція створення хешу блоку
function createHash(block) {
  // Копія блоку без полів hash та _id
  const blockForHashing = { ...block };
  delete blockForHashing.hash;
  delete blockForHashing._id;
  
  // Сортуємо ключі для стабільного хешування
  const orderedBlock = {};
  Object.keys(blockForHashing).sort().forEach(key => {
    orderedBlock[key] = blockForHashing[key];
  });
  
  return crypto.createHash('sha256').update(JSON.stringify(orderedBlock)).digest('hex');
}

// Перевірка валідності блоку
function isBlockValid(block) {
  const calculatedHash = createHash(block);
  return block.hash === calculatedHash;
}

// Валідація ланцюга блоків
async function validateChain() {
  try {
    // Отримання блоків відсортованих за часом створення
    const blocks = await blocksCollection.find({}).sort({ creationDate: 1 }).toArray();
    
    if (blocks.length === 0) {
      return { valid: true, message: "Ланцюг порожній" };
    }
    
    // Обробка для першого блоку
    const firstBlock = blocks[0];
    
    // Перевірка хешу першого блоку
    if (!isBlockValid(firstBlock)) {
      return {
        valid: false,
        message: `Невалідний перший блок: ${firstBlock._id}, хеш не відповідає вмісту`,
        blockIndex: 0
      };
    }
    
    // Перевірка previousHash першого блоку
    if (firstBlock.previousHash !== "0") {
      return {
        valid: false,
        message: `Невалідний перший блок: ${firstBlock._id}, previousHash повинен бути "0"`,
        blockIndex: 0
      };
    }
    
    let previousHash = firstBlock.hash; // Перевірка другого блоку
    
    // Перевірка решти блоків
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      
      // Перевірка хешу блоку
      if (!isBlockValid(block)) {
        return {
          valid: false,
          message: `Невалідний блок: ${block._id}, хеш не відповідає вмісту`,
          blockIndex: i
        };
      }
      
      // Перевірка зв'язку з попереднім блоком
      if (block.previousHash !== previousHash) {
        return {
          valid: false,
          message: `Невалідний ланцюг: блок ${block._id} має неправильний попередній хеш`,
          blockIndex: i
        };
      }
      
      // Оновлюємо previousHash для наступної ітерації
      previousHash = block.hash;
    }
    
    return { valid: true, message: "Ланцюг валідний" };
  } catch (err) {
    console.error("❌ Помилка при валідації ланцюга блоків:", err);
    return { valid: false, message: "Помилка при валідації ланцюга", error: err.message };
  }
}

// Отримання інформації про роль користувача
async function getUserRole(userId) {
  try {
    // Шукаємо користувача безпосередньо в базі даних для ефективності
    const objectId = new ObjectId(userId);
    const user = await usersCollection.findOne({ _id: objectId });
    
    if (!user) {
      console.error(`Користувача з ID ${userId} не знайдено`);
      return null;
    }
    
    return {
      userId: userId,
      status: user.status || "user",
      groupId: user.groupId
    };
  } catch (error) {
    console.error("Помилка при отриманні ролі користувача:", error);
    
    // Якщо виникла помилка з прямим доступом, спробуємо запит до API
    try {
      const url = `${authServerUrl}/user-role/${userId}`;
      const response = await fetch(url);
      
      if (response.ok) {
        return await response.json();
      } else {
        console.error(`Помилка при отриманні ролі користувача через API: HTTP ${response.status}`);
        return null;
      }
    } catch (apiError) {
      console.error("Помилка при запиті до API:", apiError);
      return null;
    }
  }
}

// Функція для перевірки, чи може користувач голосувати
async function canUserVote(userId, voteId) {
  try {
    // Перевіряємо, чи користувач є адміністратором
    const userInfo = await getUserRole(userId);
    if (userInfo && userInfo.status === "admin") {
      return { canVote: false, message: "Адміністратори не можуть брати участь у голосуванні" };
    }

    // Перевіряємо наявність голосу для цього голосування
    const existingVote = await blocksCollection.findOne({ voterId: userId, voteId, type: "vote" });
    if (existingVote) {
      return { canVote: false, message: "Ви вже віддали голос за це голосування" };
    }

    // Перевіряємо, чи існує голосування і чи не закінчився термін
    const voteBlock = await blocksCollection.findOne({ voteId, type: "create_vote" });
    if (!voteBlock) {
      return { canVote: false, message: "Таке голосування не існує" };
    }

    const now = new Date();
    if (new Date(voteBlock.endDate) < now) {
      return { canVote: false, message: "Голосування вже закінчилося" };
    }

    return { canVote: true, voteBlock };
  } catch (error) {
    console.error("Помилка при перевірці права голосу:", error);
    return { canVote: false, message: "Помилка сервера при перевірці права голосу" };
  }
}

// Додавання нового блоку
async function addBlock(newBlock) {
  try {
    // Валідація ланцюга
    const chainValidation = await validateChain();
    if (!chainValidation.valid) {
      return { 
        success: false, 
        error: "Неможливо додати новий блок - ланцюг блоків пошкоджено", 
        details: chainValidation 
      };
    }

    // Отримання останнього блоку для підключення
    const lastBlock = await blocksCollection.findOne({}, { sort: { creationDate: -1 } });
    const previousHash = lastBlock ? lastBlock.hash : "0";

    // Додаємо поля до блоку
    newBlock.previousHash = previousHash;
    newBlock.creationDate = new Date();
    
    // Створюємо хеш для блоку
    newBlock.hash = createHash(newBlock);

    // Зберігаємо блок
    await blocksCollection.insertOne(newBlock);
    return { success: true, block: newBlock };
  } catch (error) {
    console.error("Помилка при додаванні блоку:", error);
    return { success: false, error: "Помилка сервера при додаванні блоку" };
  }
}

// Отримання ланцюга з фільтрацією по groupId
app.get('/chain', async (req, res) => {
  try {
    const userGroupId = req.query.groupId; // Отримуємо groupId з запиту
    
    // Отримуємо всі блоки
    const blocks = await blocksCollection.find({}).toArray();
    
    // Якщо groupId не вказаний, повертаємо всі блоки
    if (!userGroupId) {
      return res.json(blocks);
    }
    
    // Якщо groupId вказаний, фільтруємо блоки на сервері
    const filteredBlocks = blocks.filter(block => {
      if (block.type !== "create_vote") return true; // Перевірка чи ж блок голосуванням
      
      // Перевіряємо, голосування публічне або для групи користувача
      return Array.isArray(block.groupIds) && 
             (block.groupIds.includes("all") || block.groupIds.includes(userGroupId));
    });
    
    res.json(filteredBlocks);
  } catch (err) {
    console.error('Помилка отримання блокчейну:', err);
    res.status(500).json({ error: 'Помилка отримання блокчейну' });
  }
});

// Ендпоінт для перевірки цілісності ланцюга
app.get('/validate', async (req, res) => {
  try {
    const validationResult = await validateChain();
    res.json(validationResult);
  } catch (err) {
    console.error('Помилка при валідації ланцюга:', err);
    res.status(500).json({ error: 'Помилка при валідації ланцюга блоків' });
  }
});

// Ендпоінт для перегляду стану ланцюга
app.get('/debug/chain', async (req, res) => {
  try {
    const blocks = await blocksCollection.find({}).sort({ creationDate: 1 }).toArray();
    
    const debugInfo = {
      blockCount: blocks.length,
      blocks: blocks.map(block => ({
        _id: block._id,
        type: block.type,
        voteId: block.voteId,
        creationDate: block.creationDate,
        previousHash: block.previousHash,
        hash: block.hash,
        isValidHash: createHash(block) === block.hash
      }))
    };
    
    res.json(debugInfo);
  } catch (err) {
    console.error('Помилка при отриманні дебаг-інформації:', err);
    res.status(500).json({ error: 'Помилка при отриманні дебаг-інформації', details: err.message });
  }
});

// Функція створення нового голосування
app.post('/create_vote', async (req, res) => {
  const { voteId, title, description, options, creatorId, endDate, groupIds } = req.body;

  // Перевірка даних
  if (!voteId || !title || !description || !options || !creatorId || !Array.isArray(options) || options.length === 0) {
    return res.status(400).json({ error: "Не вистачає даних для створення голосування" });
  }

  try {
    // Перевіряємо чи роль користувача - адміністратор
    const userInfo = await getUserRole(creatorId);
    if (!userInfo || userInfo.status !== "admin") {
      return res.status(403).json({ error: "Тільки адміністратори можуть створювати голосування" });
    }

    // Перевірка, чи є голосування з таким же voteId
    const existingVote = await blocksCollection.findOne({ voteId, type: "create_vote" });
    if (existingVote) {
      return res.status(400).json({ error: "Це голосування вже існує" });
    }

    const currentDate = new Date();
    
    // Використовлення дату завершення з запиту (або за замовчуванням)
    let finalEndDate;
    if (endDate) {
      finalEndDate = new Date(endDate);
      // Перевірка правильності дати заверщення
      if (finalEndDate <= currentDate) {
        return res.status(400).json({ error: "Дата завершення повинна бути в майбутньому" });
      }
    } else {
      // За замовчуванням - 30 днів
      finalEndDate = new Date();
      finalEndDate.setDate(finalEndDate.getDate() + 30);
    }

    // Перевіряємо groupIds (якщо не вказано, використовуємо "all")
    const voteGroupIds = Array.isArray(groupIds) && groupIds.length > 0 ? groupIds : ["all"];

    // Створення блоку нового голосування
    const newVoteBlock = {
      type: "create_vote",
      voteId,
      creatorId,
      endDate: finalEndDate,
      title,
      description,
      options,
      groupIds: voteGroupIds,
    };

    // Додаємо блок
    const result = await addBlock(newVoteBlock);
    
    if (result.success) {
      res.json({ message: "Голосування створено", block: result.block });
    } else {
      res.status(500).json({ error: result.error, details: result.details });
    }
  } catch (err) {
    console.error('Помилка при створенні голосування:', err);
    res.status(500).json({ error: 'Помилка при створенні голосування' });
  }
});

// Ендпоінт для голосування
app.post('/vote', async (req, res) => {
  const { voterId, voteId, candidate } = req.body;

  if (!voterId || !voteId || !candidate) {
    return res.status(400).json({ error: "Не вистачає даних для голосування" });
  }

  try {
    // Перевірка, чи може користувач голосувати
    const voteCheck = await canUserVote(voterId, voteId);
    if (!voteCheck.canVote) {
      return res.status(403).json({ error: voteCheck.message });
    }
    
    // Перевірка наявності варіанту вибору
    if (!voteCheck.voteBlock.options.includes(candidate)) {
      return res.status(400).json({ error: "Невалідний варіант для голосування" });
    }

    // Створення блоку для голосування
    const newVoteBlock = {
      type: "vote",
      voterId,
      voteId,
      candidate
    };

    // Додаємо блок
    const result = await addBlock(newVoteBlock);
    
    if (result.success) {
      res.json({ message: "Голос збережено", block: result.block });
    } else {
      res.status(500).json({ error: result.error, details: result.details });
    }
  } catch (err) {
    console.error('Помилка при збереженні голосу:', err);
    res.status(500).json({ error: 'Помилка при збереженні голосу' });
  }
});

// Ендпоінт отримання результатів голосування
app.get('/results/:voteId', async (req, res) => {
  const voteId = req.params.voteId;
  
  try {
    // Перевірка наявності голосування
    const voteBlock = await blocksCollection.findOne({ voteId, type: "create_vote" });
    if (!voteBlock) {
      return res.status(404).json({ error: "Таке голосування не існує" });
    }
    
    // Отримання всіх голосів голосування
    const votes = await blocksCollection.find({ voteId, type: "vote" }).toArray();
    
    // Підрахунок результатів
    const results = {};
    voteBlock.options.forEach(option => {
      results[option] = 0;
    });
    
    votes.forEach(vote => {
      if (results[vote.candidate] !== undefined) {
        results[vote.candidate]++;
      }
    });
    
    // Формування відповіді
    const response = {
      voteId,
      title: voteBlock.title,
      totalVotes: votes.length,
      results: results,
      isActive: new Date(voteBlock.endDate) > new Date()
    };
    
    res.json(response);
  } catch (err) {
    console.error('Помилка при отриманні результатів голосування:', err);
    res.status(500).json({ error: 'Помилка при отриманні результатів голосування' });
  }
});

// Тестовий ендпоінт
app.get('/test', (req, res) => {
  res.send("Сервер працює!");
});

// Запуск сервера
connectDB().then(() => {
  app.listen(port, () => {
    console.log(`✅ API-сервер запущено на http://localhost:${port}`);
  });
});
