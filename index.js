require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require('firebase-admin')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

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
    origin: [process.env.CLIENT_DOMAIN],
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

    const ordersCollection = db.collection('orders')


    // save a product data in db
    app.post('/products', async (req, res) => {
      const productData = req.body
      const result = await productsCollection.insertOne(productData)
      res.send(result)
    })


    // get all products from db
    app.get('/products', async (req, res) => {
      const result = await productsCollection.find().toArray()
      res.send(result)
    })



    // get product details
    app.get('/products/:id', async (req, res) => {
      const id = req.params.id
      const result = await productsCollection.findOne({ _id: new ObjectId(id) })
      res.send(result)
    })


    // payment related apis
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body
      console.log(paymentInfo)
      // res.send(paymentInfo)
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: paymentInfo?.name,
                description: paymentInfo?.description,
                images: [paymentInfo?.image],
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: paymentInfo?.availableQuantity,
          },
        ],
        mode: 'payment',
        metadata: {
          productId: paymentInfo?.productId,
          buyer: paymentInfo?.buyer.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/product/${paymentInfo?.productId}`,
      })

      res.send({ url: session.url })

    })


    app.post('/payment-success', async (req, res) => {
      const { sessionId } = req.body
      const session = await stripe.checkout.sessions.retrieve(sessionId)

      const product = await productsCollection.findOne({ _id: new ObjectId(session.metadata.productId) })

      const order = await ordersCollection.findOne({ transactionId: session.payment_intent })


      if (session.status === 'complete' && product && !order) {
        // save order data in db
        const orderInfo = {
          productId: session.metadata.productId,
          transactionId: session.payment_intent,
          buyer: session.metadata.buyer,
          status: 'Pending',
          manager: product.manager,
          name: product.name,
          category: product.category,
          availableQuantity: product.availableQuantity,
          price: session.amount_total / 100,
        }
        const result = await ordersCollection.insertOne(orderInfo)
        // update product available quantity
        await productsCollection.updateOne(
          {
            _id: new ObjectId(session.metadata.productId),
          },
          { $inc: { availableQuantity: -1 } }
        )

        return res.send({
          transactionId: session.payment_intent,
          orderId: result.insertedId,

        })
      }
      res.send(
        res.send({
          transactionId: session.payment_intent,
          orderId: order._id,

        })
      )
    })


    // get all orders for a buyer by email
    app.get('/my-orders/:email', async(req, res) => {
      const email = req.params.email
      const result = await ordersCollection.find({ buyer: email }).toArray()
      res.send(result)
    })



    // get api for approve orders
    app.get('/approve-orders/:email', async(req, res) => {
      const email = req.params.email
      const result = await ordersCollection.find({ 'manager.email': email }).toArray()
      res.send(result)
    })



    // get all plants for a manager by email
    app.get('/manage-product/:email', async(req, res) => {
      const email = req.params.email
      const result = await productsCollection.find({ 'manager.email': email }).toArray()
      res.send(result)
    })



    // New API: Update a product by ID (PUT method)
    app.put('/product/:id', async (req, res) => {
      const id = req.params.id 
      const updatedProductData = req.body 
      
      const query = { _id: new ObjectId(id) }
      
      const updateDoc = {
        $set: {
          ...updatedProductData, 
        },
      }

      const result = await productsCollection.updateOne(query, updateDoc)

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
