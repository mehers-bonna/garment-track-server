require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require('firebase-admin')
const port = process.env.PORT || 3000
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf-8'
)
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const app = express()


// middleware
app.use(express.json())
// app.use(cors());

app.use(
  cors({
    origin: [
      'http://localhost:5173',
      'http://localhost:5174',
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
)


// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.uftqhoa.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});


async function run() {
  try {

    
    const db = client.db('productsDB')
    const productsCollection = db.collection('products')


    // save a product data in db
    app.post('/products', async(req, res) => {
      const productData = req.body
      const result = await productsCollection.insertOne(productData)
      res.send(result)
    })


    // get all products from db
    app.get('/products', async(req, res) => {
      const result = await productsCollection.find().toArray()
      res.send(result)
    })



    // get product details
    app.get('/products/:id', async(req, res) => {
      const id = req.params.id
      const result = await productsCollection.findOne({_id: new ObjectId(id)})
      res.send(result)
    })
















    
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);








app.get('/', (req, res) => {
  res.send('Garment Track server is running')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
